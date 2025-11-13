import { OpusEncoder } from '@discordjs/opus'
import {
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus
} from '@discordjs/voice'
import type { VoiceBasedChannel } from 'discord.js'
import { encode } from 'msgpackr'
import type { Readable } from 'node:stream'
import WebSocket from 'ws'

type RecSession = {
  recordingId: string
  guildId: string
  channelId: string
  ws: WebSocket
  cleanup: () => Promise<void>
  done: Promise<{ recordingId: string; vttPath: string }>
}

const sessions = new Map<string, RecSession>() // by guildId

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export async function startRecording(guildId: string, channel: VoiceBasedChannel) {
  if (sessions.has(guildId)) throw new Error('Recording already active in this guild')

  const recordingId = `${channel.id}-${utcStamp()}`
  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false
  })
  await entersState(conn, VoiceConnectionStatus.Ready, 20_000)

  const port = Number(process.env.AUDIO_WS_PORT) || 8765
  const ws = new WebSocket(`ws://localhost:${port}`)
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res())
    ws.once('error', (e) => rej(e))
  })

  // Promise resolves when server signals recording completion
  let resolveDone!: (v: { recordingId: string; vttPath: string }) => void
  const done = new Promise<{ recordingId: string; vttPath: string }>((resolve) => (resolveDone = resolve))
  ws.on('message', (data: WebSocket.RawData) => {
    try {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
      const msg = JSON.parse(text)
      if (msg && msg.type === 'done' && msg.recordingId === recordingId && msg.vttPath) {
        resolveDone({ recordingId, vttPath: String(msg.vttPath) })
      }
    } catch {}
  })

  const receiver = conn.receiver
  const decoders = new Map<string, OpusEncoder>()
  const streams = new Map<string, Readable>()

  // init connection context (recordingId, rate, channels) for the server
  try {
    ws.send(encode({ type: 'init', recordingId, rate: 48000, channels: 2 }))
  } catch {}

  const onStart = (userId: string) => {
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual }
    })
    const decoder = new OpusEncoder(48000, 2)
    decoders.set(userId, decoder)
    streams.set(userId, opusStream as unknown as Readable)
    opusStream
      .on('data', (opusPacket: Buffer) => {
        try {
          const out = decoder.decode(opusPacket)
          const pcm = Buffer.isBuffer(out) ? out : Buffer.from((out as any).buffer)
          if (ws.readyState === ws.OPEN) {
            ws.send(
              encode({
                type: 'audio',
                recordingId,
                userId,
                payload: pcm,
                encoding: 's16le',
                rate: 48000,
                channels: 2
              })
            )
          }
        } catch {}
      })
      .on('error', () => {})
  }

  receiver.speaking.on('start', onStart)

  const onEnd = (userId: string) => {
    const d = decoders.get(userId)
    if (d) decoders.delete(userId)
    const s = streams.get(userId)
    if (s) {
      try {
        // explicitly end/destroy manual streams
        if (typeof (s as any).destroy === 'function') (s as any).destroy()
        else if (typeof (s as any).push === 'function') (s as any).push(null)
      } catch {}
      streams.delete(userId)
    }
  }
  receiver.speaking.on('end', onEnd)

  const cleanup = async () => {
    try {
      receiver.speaking.removeListener('start', onStart)
      receiver.speaking.removeListener('end', onEnd)
    } catch {}
    try {
      ws.readyState === ws.OPEN && ws.send(encode({ type: 'stop', recordingId }))
    } catch {}
    // destroy any remaining user streams
    try {
      for (const [uid, s] of streams.entries()) {
        try {
          if (typeof (s as any).destroy === 'function') (s as any).destroy()
          else if (typeof (s as any).push === 'function') (s as any).push(null)
        } catch {}
        streams.delete(uid)
      }
      decoders.clear()
    } catch {}
    try {
      const existing = getVoiceConnection(channel.guild.id)
      existing?.destroy()
    } catch {}
  }

  const sess: RecSession = { recordingId, guildId: channel.guild.id, channelId: channel.id, ws, cleanup, done }
  sessions.set(guildId, sess)
  return sess
}

export async function stopRecording(guildId: string) {
  const sess = sessions.get(guildId)
  if (!sess) throw new Error('No active recording')
  await sess.cleanup()
  const result = await sess.done
  try {
    sess.ws.close()
  } catch {}
  sessions.delete(guildId)
  return { ...sess, ...result }
}

export function getActiveRecording(guildId: string) {
  return sessions.get(guildId)
}
