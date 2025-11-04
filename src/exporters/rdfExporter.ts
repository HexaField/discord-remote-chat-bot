import fsp from 'node:fs/promises'
import path from 'node:path'

// Minimal RDF exporter producing Turtle and JSON-LD files.
// This is intentionally small and forgiving for MVP: nodes become subjects with rdfs:label
// and relationships become triples using a simple predicate namespace.

function safeTmpName(dir: string, base: string, ext: string) {
  return path.join(dir, `${base}.${ext}.partial`)
}

async function atomicWrite(filePath: string, data: string) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const tmp = path.join(dir, `.${base}.partial`)
  await fsp.writeFile(tmp, data, 'utf8')
  await fsp.rename(tmp, filePath)
}

export async function exportRDF(
  dir: string,
  baseName: string,
  nodes: string[],
  relationships: Array<{ subject: string; predicate: string; object: string }>
) {
  await fsp.mkdir(dir, { recursive: true })

  const ttlPath = path.join(dir, `${baseName}.triples.ttl`)

  // Build simple Turtle
  const prefix = `@prefix ex: <http://example.org/> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n\n`
  const nodeLines = nodes.map((n, i) => `ex:node${i} rdfs:label "${n.replace(/"/g, '\\"')}" .`)

  // relationships are expected as objects { subject, predicate, object }
  const relLines: string[] = []
  for (const rel of relationships) {
    if (!rel || typeof rel !== 'object') continue
    const from = String(rel.subject || '')
    const to = String(rel.object || '')
    const label = String(rel.predicate || '')
    if (!from || !label || !to) continue
    const fi = nodes.indexOf(from)
    const ti = nodes.indexOf(to)
    const f = fi >= 0 ? `ex:node${fi}` : `"${from.replace(/"/g, '\\"')}"`
    const t = ti >= 0 ? `ex:node${ti}` : `"${to.replace(/"/g, '\\"')}"`
    const pred = `ex:${label.replace(/[^a-zA-Z0-9_]/g, '_')}`
    relLines.push(`${f} ${pred} ${t} .`)
  }

  const ttl = prefix + [...nodeLines, ...relLines].join('\n') + '\n'

  // Atomic write the Turtle file only (JSON-LD omitted for now)
  await atomicWrite(ttlPath, ttl)

  return { ttlPath }
}

export function parseTTL(content: string) {
  type Relationship = { subject: string; predicate: string; object: string }
  const nodeMap = new Map<number, string>()
  const relationships: Relationship[] = []
  const lines = content.split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^ex:node(\d+)\s+rdfs:label\s+"((?:\\"|[^"])*)"\s*\./)
    if (m) {
      const idx = Number(m[1])
      const label = m[2].replace(/\\"/g, '"')
      nodeMap.set(idx, label)
    }
  }
  // build nodes array ordered by index
  const maxIdx = Math.max(-1, ...Array.from(nodeMap.keys()))
  const nodes: string[] = []
  for (let i = 0; i <= maxIdx; i++) nodes.push(nodeMap.get(i) ?? `node${i}`)

  // parse relationships and return them as objects { subject, predicate, object }
  for (const line of lines) {
    const rm = line.match(/^ex:node(\d+)\s+ex:([^ \t]+)\s+(ex:node(\d+)|"((?:\\\"|[^"])*)")\s*\./)
    if (rm) {
      const fromIdx = Number(rm[1])
      const pred = rm[2]
      let toLabel = ''
      if (rm[4] !== undefined) {
        const toIdx = Number(rm[4])
        toLabel = nodeMap.get(toIdx) ?? `node${toIdx}`
      } else if (rm[5] !== undefined) {
        toLabel = rm[5].replace(/\\\"/g, '"')
      }
      const fromLabel = nodeMap.get(fromIdx) ?? `node${fromIdx}`
      const predLabel = pred.replace(/_/g, ' ')
      relationships.push({ subject: fromLabel, predicate: predLabel, object: toLabel })
    }
  }

  return { nodes, relationships }
}

export default exportRDF
