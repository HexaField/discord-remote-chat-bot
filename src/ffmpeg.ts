import { exec as cpExec } from 'node:child_process'
import util from 'node:util'

const exec = util.promisify(cpExec)

function escapePath(p: string) {
  // Simple quoting for paths
  return `"${p.replace(/"/g, '\\"')}"`
}

export async function convertTo16kMonoWav(inputPath: string, outputPath: string) {
  const cmd = `ffmpeg -y -i ${escapePath(inputPath)} -ar 16000 -ac 1 -c:a pcm_s16le ${escapePath(outputPath)}`
  // Increase buffer in case ffmpeg emits a lot
  await exec(cmd, { maxBuffer: 20 * 1024 * 1024 })
}

export async function ensureFfmpegAvailable() {
  try {
    await exec('ffmpeg -version')
  } catch (err) {
    throw new Error('ffmpeg not available on PATH')
  }
}
