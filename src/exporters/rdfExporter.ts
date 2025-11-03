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

export async function exportRDF(dir: string, baseName: string, nodes: string[], relationships: string[]) {
  await fsp.mkdir(dir, { recursive: true })

  const ttlPath = path.join(dir, `${baseName}.triples.ttl`)
  const jsonldPath = path.join(dir, `${baseName}.triples.jsonld`)

  // Build simple Turtle
  const prefix = `@prefix ex: <http://example.org/> .\n@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n\n`
  const nodeLines = nodes.map((n, i) => `ex:node${i} rdfs:label "${n.replace(/"/g, '\\"')}" .`)

  // relationships are expected like "A -rel-> B" or similar; we will try to split into three parts
  const relLines: string[] = []
  for (const rel of relationships) {
    let parts = rel
      .split(/-+>|—|–/g)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length !== 3) {
      const p2 = rel
        .split('-')
        .map((s) => s.trim())
        .filter(Boolean)
      if (p2.length >= 3) parts = [p2.shift() as string, p2.slice(0, -1).join('-'), p2.pop() as string]
    }
    if (parts.length === 3) {
      const [from, label, to] = parts
      const fi = nodes.indexOf(from)
      const ti = nodes.indexOf(to)
      const f = fi >= 0 ? `ex:node${fi}` : `"${from.replace(/"/g, '\\"')}"`
      const t = ti >= 0 ? `ex:node${ti}` : `"${to.replace(/"/g, '\\"')}"`
      const pred = `ex:${label.replace(/[^a-zA-Z0-9_]/g, '_')}`
      relLines.push(`${f} ${pred} ${t} .`)
    }
  }

  const ttl = prefix + [...nodeLines, ...relLines].join('\n') + '\n'

  // Build simple JSON-LD graph
  const graph: any[] = nodes.map((n, i) => ({ '@id': `http://example.org/node${i}`, 'rdfs:label': n }))
  for (const rel of relationships) {
    let parts = rel
      .split(/-+>|—|–/g)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length !== 3) {
      const p2 = rel
        .split('-')
        .map((s) => s.trim())
        .filter(Boolean)
      if (p2.length >= 3) parts = [p2.shift() as string, p2.slice(0, -1).join('-'), p2.pop() as string]
    }
    if (parts.length === 3) {
      const [from, label, to] = parts
      const fi = nodes.indexOf(from)
      const ti = nodes.indexOf(to)
      const subj = fi >= 0 ? `http://example.org/node${fi}` : `http://example.org/${encodeURIComponent(from)}`
      const obj = ti >= 0 ? `http://example.org/node${ti}` : `http://example.org/${encodeURIComponent(to)}`
      const pred = `http://example.org/${label.replace(/[^a-zA-Z0-9_]/g, '_')}`
      graph.push({ '@id': subj, [pred]: { '@id': obj } })
    }
  }

  const jsonld = {
    '@context': {
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#'
    },
    '@graph': graph
  }

  // Atomic writes
  await atomicWrite(ttlPath, ttl)
  await atomicWrite(jsonldPath, JSON.stringify(jsonld, null, 2))

  return { ttlPath, jsonldPath }
}

export default exportRDF
