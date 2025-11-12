import cors from 'cors'
import express, { Request, Response } from 'express'
import fs from 'fs'
import multer from 'multer'
import path from 'path'
import audioToDiagram from '../../src/audioToDiagram'
import { convertToMp3, ensureFfmpegAvailable } from '../../src/interfaces/ffmpeg'

const app = express()
app.use(cors())
app.use(express.json())

// Root directory for processed videos. Under this directory each subdirectory is
// treated as a "universe" containing video folders. For backwards
// compatibility, existing single-folder setups will still work.
const DATA_ROOT = path.resolve(process.cwd(), '.tmp', 'audio-to-diagram')

function listUniverses() {
  if (!fs.existsSync(DATA_ROOT)) return []
  return fs.readdirSync(DATA_ROOT).filter((d) => fs.statSync(path.join(DATA_ROOT, d)).isDirectory())
}

interface VideoItem {
  id: string // youtube id
  title?: string
  transcriptPath?: string
  vttPath?: string
  graphPath?: string
  universe?: string
}

function readItems(universe?: string): VideoItem[] {
  const base = universe ? path.join(DATA_ROOT, universe) : DATA_ROOT
  if (!fs.existsSync(base)) return []
  const dirs = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory())
  return dirs.map((dir) => {
    const transcriptPath = path.join(base, dir, 'transcript.json')
    const vttPath = path.join(base, dir, 'audio.vtt')
    const graphPath = path.join(base, dir, 'graph.json')
    let title: string | undefined
    let thumbnail: string | undefined
    const metaPath = path.join(base, dir, 'meta.json')
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
      graphPath: fs.existsSync(graphPath) ? graphPath : undefined,
      // include universe marker for client convenience
      universe: universe || undefined
    } as any
  })
}

app.get('/api/videos', (req: Request, res: Response) => {
  const universe = typeof req.query.universe === 'string' ? req.query.universe : undefined
  const items = readItems(universe).map((v) => ({ id: v.id, title: v.title, thumbnail: (v as any).thumbnail }))
  res.json(items)
})

// List available universes
app.get('/api/universes', (_req: Request, res: Response) => {
  const u = listUniverses()
  res.json(u)
})

// Create a universe (folder)
app.post('/api/universes', (req: Request, res: Response) => {
  const name = (req.body && req.body.name) || req.query.name
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Missing name' })
  const safe = String(name)
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .slice(0, 64)
  const dir = path.join(DATA_ROOT, safe)
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return res.json({ name: safe })
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Delete a video's folder and all artifacts. Accepts optional ?universe=...
app.delete('/api/videos/:id', (req: Request, res: Response) => {
  const { id } = req.params
  const universe = typeof req.query.universe === 'string' ? req.query.universe : undefined
  try {
    const dir = universe ? path.join(DATA_ROOT, universe, id) : path.join(DATA_ROOT, id)
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Not found' })
    // remove recursively
    try {
      // Node >=14.14 supports rmSync; fallback to rmdirSync for older
      if ((fs as any).rmSync) (fs as any).rmSync(dir, { recursive: true, force: true })
      else fs.rmdirSync(dir, { recursive: true })
    } catch (e) {
      // best-effort: try deleting contents then dir
      try {
        const files = fs.readdirSync(dir)
        for (const f of files) {
          const p = path.join(dir, f)
          if (fs.statSync(p).isDirectory()) fs.rmdirSync(p, { recursive: true })
          else fs.unlinkSync(p)
        }
        fs.rmdirSync(dir)
      } catch (err) {
        return res.status(500).json({ error: String((err as any)?.message || err) })
      }
    }
    return res.json({ id, universe })
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e) })
  }
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
  const universe = typeof req.query.universe === 'string' ? req.query.universe : undefined
  const item = readItems(universe).find((v) => v.id === id)
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
  const universe = typeof req.query.universe === 'string' ? req.query.universe : undefined
  const item = readItems(universe).find((v) => v.id === id)
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
  const universe = req.query.universe! as string
  if (!universe) return res.status(400).json({ error: 'Missing universe parameter' })
  const item = readItems(universe).find((v) => v.id === id)
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
    const dir = path.join(DATA_ROOT, item.universe ?? '', id)
    const graphPath = path.join(dir, 'graph.json')
    const progressPath = path.join(dir, 'progress.json')

    function persistProgress(msg: string) {
      try {
        const out = { status: msg, updated: Date.now() }
        fs.writeFileSync(progressPath, JSON.stringify(out, null, 2), 'utf8')
      } catch (e) {
        console.error('Failed to write progress.json', e)
      }
    }

    // mark start
    persistProgress('Starting regeneration…')
    const notify = (m: string) => {
      try {
        persistProgress(m)
      } catch (e) {}
      console.log('[regen]', m)
    }

    try {
      // Prefer re-running the full pipeline so all artifacts (vtt, transcript,
      // graph) are recreated. Try to pick a sensible source file from the
      // existing folder: audio.mp3, transcript.fathom.txt, audio.vtt, or
      // transcript.json. If none exists, fall back to the in-memory CLD
      // generator using the parsed `transcripts` array.
      let sourceUrl: string | undefined
      const audioPath = path.join(dir, 'audio.mp3')
      const fathomPath = path.join(dir, 'transcript.fathom.txt')
      const vttPath = path.join(dir, 'audio.vtt')
      const transcriptJsonPath = item.transcriptPath ? item.transcriptPath : path.join(dir, 'transcript.json')

      if (fs.existsSync(audioPath)) sourceUrl = `file://${audioPath}`
      else if (fs.existsSync(fathomPath)) sourceUrl = `file://${fathomPath}`
      else if (fs.existsSync(vttPath)) sourceUrl = `file://${vttPath}`
      else if (item.transcriptPath && fs.existsSync(item.transcriptPath)) sourceUrl = `file://${item.transcriptPath}`

      if (sourceUrl) {
        persistProgress('Starting full pipeline (audioToDiagram) ...')
        // audioToDiagram returns an object with `dir` where it wrote outputs.
        const out = await audioToDiagram(universe, sourceUrl, notify, true)
        // If the pipeline produced a graph.json in its output dir, copy it
        // back into the current video directory so the UI will pick up the
        // updated graph in-place.
        try {
          if (out && out.dir) {
            const generatedGraph = path.join(out.dir, 'graph.json')
            if (fs.existsSync(generatedGraph)) {
              fs.copyFileSync(generatedGraph, graphPath)
              const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
              persistProgress('Done')
              return res.json(raw)
            }
          }
        } catch (e) {
          // fall through to attempt CLD fallback or error below
          console.error('[regenerate] copying generated graph failed', e)
        }
        // If we reach here, audioToDiagram ran but no graph was found to copy.
        // Return a generic success message and let the client refresh graph
        // via the normal /api/videos/:id/graph route.
        persistProgress('Done')
        return res.json({ status: 'ok' })
      } else {
        throw new Error('No source audio or transcript file found for regeneration')
      }
    } catch (err: any) {
      persistProgress('Failed: ' + String(err?.message || err))
      console.error('[regenerate] failed', err)
      return res.status(500).json({ error: String(err?.message || err) })
    }
  } catch (e: any) {
    console.error('[regenerate] failed', e)
    return res.status(500).json({ error: String(e?.message || e) })
  }
})

// Return per-video progress persisted at DATA_ROOT/<universe>?/<id>/progress.json
app.get('/api/videos/:id/progress', (req: Request, res: Response) => {
  const { id } = req.params
  const universe = typeof req.query.universe === 'string' ? req.query.universe : undefined
  const item = readItems(universe).find((v) => v.id === id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  try {
    const dir = path.join(DATA_ROOT, item.universe ?? '', id)
    const progressPath = path.join(dir, 'progress.json')
    if (!fs.existsSync(progressPath)) return res.status(404).json({ error: 'Not found' })
    const raw = fs.readFileSync(progressPath, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      return res.json(parsed)
    } catch (e) {
      return res.status(200).json({ status: raw, updated: fs.statSync(progressPath).mtimeMs })
    }
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read progress' })
  }
})

// Server-Sent Events stream for per-video progress. Clients can open a
// persistent connection to receive updates whenever progress.json changes.
app.get('/api/videos/:id/progress/stream', (req: Request, res: Response) => {
  const { id } = req.params
  const universe = typeof req.query.universe === 'string' ? req.query.universe : undefined
  const item = readItems(universe).find((v) => v.id === id)
  if (!item) return res.status(404).json({ error: 'Not found' })
  try {
    const dir = path.join(DATA_ROOT, item.universe ?? '', id)
    const progressPath = path.join(dir, 'progress.json')

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    // allow CORS preflight to succeed
    res.flushHeaders && res.flushHeaders()

    let lastUpdated = 0

    // send helper
    const send = (obj: any) => {
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      } catch (e) {}
    }

    // send initial state if present
    if (fs.existsSync(progressPath)) {
      try {
        const raw = fs.readFileSync(progressPath, 'utf8')
        const parsed = JSON.parse(raw)
        lastUpdated = parsed?.updated ?? fs.statSync(progressPath).mtimeMs
        send(parsed)
      } catch (e) {
        // ignore parse errors
      }
    }

    // Use fs.watch on the directory for event-driven updates. Fall back to a
    // polling checker if fs.watch isn't available or fails to initialize.
    let watcher: fs.FSWatcher | null = null
    let checker: NodeJS.Timeout | null = null

    const startPoller = () => {
      checker = setInterval(() => {
        try {
          if (fs.existsSync(progressPath)) {
            const raw = fs.readFileSync(progressPath, 'utf8')
            try {
              const parsed = JSON.parse(raw)
              const updated = parsed?.updated ?? fs.statSync(progressPath).mtimeMs
              if (updated !== lastUpdated) {
                lastUpdated = updated
                send(parsed)
                // if status is Done or Failed, cleanup and close
                const st = (parsed?.status || '').toString().toLowerCase()
                if (st.startsWith('done') || st.startsWith('failed')) {
                  try {
                    fs.unlinkSync(progressPath)
                  } catch (e) {}
                  try {
                    res.end()
                  } catch (e) {}
                }
              }
            } catch (e) {
              const updated = fs.statSync(progressPath).mtimeMs
              if (updated !== lastUpdated) {
                lastUpdated = updated
                send({ status: raw, updated })
              }
            }
          } else {
            if (lastUpdated !== 0) {
              lastUpdated = 0
              send({ status: 'not-found', updated: 0 })
            }
          }
        } catch (e) {
          // swallow errors
        }
      }, 1000)
    }

    try {
      watcher = fs.watch(dir, { persistent: true }, (evt, fname) => {
        try {
          // if filename omitted, react by checking progressPath
          if (fname && path.basename(fname) !== path.basename(progressPath)) return
          if (!fs.existsSync(progressPath)) {
            if (lastUpdated !== 0) {
              lastUpdated = 0
              send({ status: 'not-found', updated: 0 })
            }
            return
          }
          const raw = fs.readFileSync(progressPath, 'utf8')
          try {
            const parsed = JSON.parse(raw)
            const updated = parsed?.updated ?? fs.statSync(progressPath).mtimeMs
            if (updated !== lastUpdated) {
              lastUpdated = updated
              send(parsed)
              const st = (parsed?.status || '').toString().toLowerCase()
              if (st.startsWith('done') || st.startsWith('failed')) {
                // cleanup and close
                try {
                  fs.unlinkSync(progressPath)
                } catch (e) {}
                try {
                  watcher && watcher.close()
                } catch (e) {}
                try {
                  res.end()
                } catch (e) {}
              }
            }
          } catch (e) {
            const updated = fs.statSync(progressPath).mtimeMs
            if (updated !== lastUpdated) {
              lastUpdated = updated
              send({ status: raw, updated })
            }
          }
        } catch (e) {
          // ignore
        }
      })
    } catch (e) {
      // fallback to poller
      startPoller()
    }

    // heartbeat to keep proxies from closing connection
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n')
      } catch (e) {}
    }, 15000)

    req.on('close', () => {
      try {
        watcher && watcher.close()
      } catch (e) {}
      if (checker) clearInterval(checker)
      clearInterval(heartbeat)
      try {
        res.end()
      } catch (e) {}
    })
  } catch (e) {
    return res.status(500).json({ error: 'Failed to open progress stream' })
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
          // universe selection may be provided as form field or query param
          const universe = (req.body && req.body.universe) || req.query.universe || 'default'
          const baseDir = path.join(DATA_ROOT, String(universe))
          if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true })

          // derive an id from the original filename (sanitized)
          const base = path.basename(f.originalname || 'upload')
          const name = base.replace(/\.fathom\.txt$/i, '').replace(path.extname(base), '')
          const safe = name.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 64) || `upload-${Date.now()}`
          let id = safe
          const targetDir = () => path.join(baseDir, id)
          if (fs.existsSync(targetDir())) {
            id = `${safe}-${Date.now()}`
          }
          const dir = path.join(baseDir, id)
          fs.mkdirSync(dir, { recursive: true })
          // If the uploaded file is a Fathom transcript, save it as transcript.fathom.txt
          // so the audioToDiagram flow will detect and parse it. Otherwise save as audio.mp3
          if (/(?:\.fathom\.txt)$/i.test(f.originalname || '')) {
            const dest = path.join(dir, `transcript.fathom.txt`)
            fs.writeFileSync(dest, f.buffer)
            // call pipeline with file:// URL to the saved transcript
            const fileUrl = `file://${dest}`
            await audioToDiagram(universe, fileUrl, notify, true)
          } else {
            // preserve original file extension (fallback to .mp3)
            const originalExt = path.extname(base) || '.mp3'
            const ext = /^\.[a-z0-9]+$/i.test(originalExt) ? originalExt : '.mp3'
            const fileOriginal = path.join(dir, `audio${ext}`)
            fs.writeFileSync(fileOriginal, f.buffer)
            const output = path.join(dir, `audio.mp3`)
            if (ext.toLowerCase() !== '.mp3') {
              // run ffmpeg to convert to mp3
              await ensureFfmpegAvailable()
              await convertToMp3(fileOriginal, output)
            }
            // run full pipeline using file:// URL to the saved file
            const fileUrl = `file://${output}`
            await audioToDiagram(universe, fileUrl, notify, true)
          }
          results.push({ file: f.originalname, id, status: 'ok', universe })
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
      // For URL imports we allow specifying a universe via body.universe or query
      const universe = (req.body && req.body.universe) || req.query.universe || 'default'
      const baseDir = path.join(DATA_ROOT, String(universe))
      if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true })
      for (const line of lines) {
        try {
          const out = await audioToDiagram(universe, line, notify, true)
          // audioToDiagram returns { dir, ... } where dir is the folder it wrote to.
          // Move the generated folder into the selected universe with a safe id.
          try {
            const base = path.basename(line).replace(path.extname(line), '')
            const safe = base.replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 64) || `import-${Date.now()}`
            let id = safe
            const targetDir = path.join(baseDir, id)
            if (fs.existsSync(targetDir)) id = `${safe}-${Date.now()}`
            const finalDir = path.join(baseDir, id)
            if (out && out.dir && fs.existsSync(out.dir)) {
              // move/rename generated dir to finalDir
              fs.renameSync(out.dir, finalDir)
            }
            results.push({ url: line, status: 'ok', id, universe })
          } catch (e) {
            results.push({ url: line, status: 'ok', info: 'generated but failed to relocate' })
          }
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
