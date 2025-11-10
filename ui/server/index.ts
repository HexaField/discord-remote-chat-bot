import cors from 'cors'
import express, { Request, Response } from 'express'
import fs from 'fs'
import multer from 'multer'
import path from 'path'
import audioToDiagram from '../../src/audioToDiagram'
import { generateCausalRelationships } from '../../src/cld'

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
    let thumbnail: string | undefined
    const metaPath = path.join(DATA_ROOT, dir, 'meta.json')
    if (fs.existsSync(metaPath)) {
      try {
        title = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).title
      } catch {}
    }
    // If no meta.json title, try graph.json metadata
    if ((!title || title === undefined) && fs.existsSync(graphPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(graphPath, 'utf-8'))
        if (!title && raw?.metadata?.title) title = raw.metadata.title
        if (!title && raw?.metadata?.name) title = raw.metadata.name
        if (raw?.metadata?.thumbnail) thumbnail = raw.metadata.thumbnail
      } catch {}
    }
    return {
      id: dir,
      title,
      thumbnail,
      transcriptPath: fs.existsSync(transcriptPath) ? transcriptPath : undefined,
      vttPath: fs.existsSync(vttPath) ? vttPath : undefined,
      graphPath: fs.existsSync(graphPath) ? graphPath : undefined
    }
  })
}

app.get('/api/videos', (_req: Request, res: Response) => {
  const items = readItems().map((v) => ({ id: v.id, title: v.title, thumbnail: (v as any).thumbnail }))
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
    if (Array.isArray(raw.nodes) && raw.nodes.length && Array.isArray(raw.relationships)) {
      // nodes may be strings or objects {label,type}
      const nodes = (raw.nodes as any[]).map((n) => {
        if (typeof n === 'string') return { id: n, label: n }
        const label = n?.label ?? n?.name ?? String(n)
        return { id: label, label, type: n?.type }
      })
      const links = (raw.relationships as any[]).map((r) => ({
        source: r.subject,
        target: r.object,
        label: r.predicate
      }))
      return res.json({ nodes, links })
    }
    if (Array.isArray(raw.nodes) && Array.isArray(raw.links)) {
      // ensure nodes have id fields
      const nodes = (raw.nodes as any[]).map((n) =>
        n.id ? n : { id: n.label ?? String(n), label: n.label ?? String(n), type: n.type }
      )
      return res.json({ nodes, links: raw.links })
    }
    return res.json(raw)
  } catch (e) {
    res.status(500).json({ error: 'Failed to read graph' })
  }
})

// Regenerate the graph for a given video id by re-running causal extraction on the
// transcript. This will call the server-side generateCausalRelationships and write
// an updated graph.json in the same directory.
app.post('/api/videos/:id/regenerate', async (req: Request, res: Response) => {
  const { id } = req.params
  const item = readItems().find((v) => v.id === id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  try {
    // Build transcript array: prefer transcriptPath JSON, otherwise parse VTT
    let transcripts: string[] = []
    if (item.transcriptPath && fs.existsSync(item.transcriptPath)) {
      const raw = fs.readFileSync(item.transcriptPath, 'utf8')
      try {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          // items may be strings or objects with `text`
          if (parsed.length && typeof parsed[0] === 'string') transcripts = parsed
          else transcripts = parsed.map((c: any) => (c && c.text ? String(c.text) : '')).filter(Boolean)
        } else if (typeof parsed === 'string') transcripts = [parsed]
      } catch (e) {
        // not JSON, treat as raw text
        if (raw.trim()) transcripts = [raw.trim()]
      }
    } else if (item.vttPath && fs.existsSync(item.vttPath)) {
      const vtt = fs.readFileSync(item.vttPath, 'utf8')
      const chunks = parseVtt(vtt)
      transcripts = chunks.map((c) => c.text).filter(Boolean)
    } else {
      return res.status(404).json({ error: 'Transcript not found for regeneration' })
    }

    // run generator
    const notify = (m: string) => console.log('[regen]', m)
    const cld = await generateCausalRelationships(
      transcripts,
      notify,
      0.85,
      true,
      process.env.SDB_LLM_MODEL,
      process.env.SDB_EMBEDDING_MODEL
    )

    // write graph.json
    const dir = path.join(DATA_ROOT, id)
    const graphPath = path.join(dir, 'graph.json')
    const out = { nodes: cld.nodes, relationships: cld.relationships }
    fs.writeFileSync(graphPath, JSON.stringify(out, null, 2), 'utf8')

    return res.json(out)
  } catch (e: any) {
    console.error('[regenerate] failed', e)
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Multer setup to accept audio file uploads (use memory storage so we can place files
// into the final DATA_ROOT/<id> directory rather than a shared uploads folder)
const upload = multer({ storage: multer.memoryStorage() })

// Import endpoint: accepts multipart file uploads (files field) or JSON body with 'text' newline-separated URLs
app.post('/api/videos/import', upload.array('files'), async (req: Request, res: Response) => {
  const results: any[] = []
  try {
    // helper notifier
    const notify = (m: string) => console.log('[import]', m)

    // Handle uploaded files (memory storage)
    const files = (req as any).files as any[] | undefined
    if (files && files.length) {
      for (const f of files) {
        try {
          // derive an id from the original filename (sanitized)
          const base = path.basename(f.originalname || 'upload')
          const name = base.replace(path.extname(base), '')
          const safe = name.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 64) || `upload-${Date.now()}`
          let id = safe
          const targetDir = () => path.join(DATA_ROOT, id)
          if (fs.existsSync(targetDir())) {
            id = `${safe}-${Date.now()}`
          }
          const dir = path.join(DATA_ROOT, id)
          fs.mkdirSync(dir, { recursive: true })
          // write uploaded file to expected audio filename so audioToDiagram will pick it up
          const dest = path.join(dir, `audio.mp3`)
          fs.writeFileSync(dest, f.buffer)
          // run full pipeline using file:// URL to the saved file
          const fileUrl = `file://${dest}`
          await audioToDiagram(fileUrl, notify, true)
          results.push({ file: f.originalname, id, status: 'ok' })
        } catch (e: any) {
          console.error('[import] file failed', f.originalname, e)
          results.push({ file: f.originalname, status: 'error', error: String(e?.message || e) })
        }
      }
      return res.json({ results })
    }

    // Handle text body with URLs (newline separated)
    if (req.is('application/json')) {
      const body = req.body as any
      const text = (body && (body.text || body.urls)) as string | undefined
      if (!text) return res.status(400).json({ error: 'No text or urls provided' })
      const lines = String(text)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      for (const line of lines) {
        try {
          await audioToDiagram(line, notify, true)
          results.push({ url: line, status: 'ok' })
        } catch (e: any) {
          console.error('[import] url failed', line, e)
          results.push({ url: line, status: 'error', error: String(e?.message || e) })
        }
      }
      return res.json({ results })
    }

    return res.status(400).json({ error: 'No files or urls provided' })
  } catch (e: any) {
    console.error('[import] failed', e)
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

const port = Number(process.env.UI_PORT) || 5175
app.listen(port, () => {
  console.log(`[ui-server] listening on http://localhost:${port}`)
})
