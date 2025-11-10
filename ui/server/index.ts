import cors from 'cors'
import express, { Request, Response } from 'express'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(cors())
app.use(express.json())

// Root directory for processed videos
const DATA_ROOT = path.resolve(process.cwd(), '.tmp', 'audio-to-diagram')

interface VideoItem {
  id: string // youtube id
  title?: string
  transcriptPath?: string
  vttPath?: string
  graphPath?: string
}

function readItems(): VideoItem[] {
  if (!fs.existsSync(DATA_ROOT)) return []
  const dirs = fs.readdirSync(DATA_ROOT).filter((d) => fs.statSync(path.join(DATA_ROOT, d)).isDirectory())
  return dirs.map((dir) => {
    const transcriptPath = path.join(DATA_ROOT, dir, 'transcript.json')
    const vttPath = path.join(DATA_ROOT, dir, 'audio.vtt')
    const graphPath = path.join(DATA_ROOT, dir, 'graph.json')
    let title: string | undefined
    const metaPath = path.join(DATA_ROOT, dir, 'meta.json')
    if (fs.existsSync(metaPath)) {
      try {
        title = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).title
      } catch {}
    }
    return {
      id: dir,
      title,
      transcriptPath: fs.existsSync(transcriptPath) ? transcriptPath : undefined,
      vttPath: fs.existsSync(vttPath) ? vttPath : undefined,
      graphPath: fs.existsSync(graphPath) ? graphPath : undefined
    }
  })
}

app.get('/api/videos', (_req: Request, res: Response) => {
  const items = readItems().map((v) => ({ id: v.id, title: v.title }))
  res.json(items)
})

function parseVtt(content: string) {
  const lines = content.split(/\r?\n/)
  const chunks: { start?: number; end?: number; text: string }[] = []
  let i = 0
  const ts = /(?<h>\d{2}):(?<m>\d{2}):(?<s>\d{2})\.(?<ms>\d{3})/
  function toSec(m: RegExpMatchArray) {
    const g: any = m.groups
    return Number(g.h) * 3600 + Number(g.m) * 60 + Number(g.s) + Number(g.ms) / 1000
  }
  while (i < lines.length) {
    const l = lines[i].trim()
    if (l.includes('-->')) {
      const [a, b] = l.split('-->')
      const m1 = a.trim().match(ts)
      const m2 = b.trim().match(ts)
      i++
      const textLines: string[] = []
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i])
        i++
      }
      chunks.push({ start: m1 ? toSec(m1) : undefined, end: m2 ? toSec(m2) : undefined, text: textLines.join(' ') })
    }
    i++
  }
  return chunks
}

app.get('/api/videos/:id/transcript', (req: Request, res: Response) => {
  const { id } = req.params
  const item = readItems().find((v) => v.id === id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  try {
    if (item.transcriptPath) {
      const json = JSON.parse(fs.readFileSync(item.transcriptPath, 'utf-8'))
      return res.json(json)
    }
    if (item.vttPath) {
      const vtt = fs.readFileSync(item.vttPath, 'utf-8')
      const chunks = parseVtt(vtt)
      return res.json(chunks)
    }
    return res.status(404).json({ error: 'Transcript not found' })
  } catch (e) {
    res.status(500).json({ error: 'Failed to read transcript' })
  }
})

app.get('/api/videos/:id/graph', (req: Request, res: Response) => {
  const { id } = req.params
  const item = readItems().find((v) => v.id === id)
  if (!item || !item.graphPath) return res.status(404).json({ error: 'Not found' })
  try {
    const raw = JSON.parse(fs.readFileSync(item.graphPath, 'utf-8'))
    // Normalize to { nodes: [{id}], links: [{source,target,label}] }
    if (
      Array.isArray(raw.nodes) &&
      raw.nodes.length &&
      typeof raw.nodes[0] === 'string' &&
      Array.isArray(raw.relationships)
    ) {
      const nodes = (raw.nodes as string[]).map((n) => ({ id: n, label: n }))
      const links = (raw.relationships as any[]).map((r) => ({
        source: r.subject,
        target: r.object,
        label: r.predicate
      }))
      return res.json({ nodes, links })
    }
    if (Array.isArray(raw.nodes) && Array.isArray(raw.links)) {
      return res.json(raw)
    }
    return res.json(raw)
  } catch (e) {
    res.status(500).json({ error: 'Failed to read graph' })
  }
})

const port = Number(process.env.UI_PORT) || 5175
app.listen(port, () => {
  console.log(`[ui-server] listening on http://localhost:${port}`)
})
