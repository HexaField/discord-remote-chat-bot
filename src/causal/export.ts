import fsp from 'fs/promises'
import path from 'path'
import { exportMermaid } from '../exporters/mermaidExporter'
import { atomicWrite } from '../utils'
import { CausalEdge, Code, ExportBundle, Graph, Loop } from './types'

export async function exportGraphJson(dir: string, base: string, graph: Graph) {
  await fsp.mkdir(dir, { recursive: true })
  const p = path.join(dir, `${base}.graph.json`)
  await atomicWrite(p, JSON.stringify(graph, null, 2))
  return p
}

export async function exportCsv(dir: string, base: string, variables: Code[], edges: CausalEdge[]) {
  const nodesCsv = ['id,label,group'].concat(
    variables.map((v) => `${csv(v.id)},${csv(v.label)},${csv(v.group)}`)
  )
  const edgesCsv = ['id,from,to,polarity,confidence'].concat(
    edges.map((e) => `${csv(e.id)},${csv(e.fromVariableId)},${csv(e.toVariableId)},${csv(e.polarity)},${e.confidence.toFixed(3)}`)
  )
  const nodesPath = path.join(dir, `${base}.nodes.csv`)
  const edgesPath = path.join(dir, `${base}.edges.csv`)
  await atomicWrite(nodesPath, nodesCsv.join('\n'))
  await atomicWrite(edgesPath, edgesCsv.join('\n'))
  return { nodesPath, edgesPath }
}

export async function exportProvenanceHtml(dir: string, base: string, edges: CausalEdge[], variables: Code[]) {
  const p = path.join(dir, `${base}.provenance.html`)
  const varLookup = new Map(variables.map((v) => [v.id, v.label]))
  const html = `<!doctype html>
<meta charset="utf-8"/>
<title>Provenance</title>
<style>body{font-family:system-ui, sans-serif;line-height:1.4} .edge{margin:1em 0;padding:0.5em;border:1px solid #ddd;border-radius:8px} .ev{margin-left:1em;color:#555}</style>
<h1>Edge provenance</h1>
${edges
  .map((e) => {
    const from = escapeHtml(varLookup.get(e.fromVariableId) || e.fromVariableId)
    const to = escapeHtml(varLookup.get(e.toVariableId) || e.toVariableId)
    const ev = e.evidence
      .map((sp) => `<div class="ev"><strong>${sp.docId}</strong> [${sp.start}-${sp.end}] — ${escapeHtml(sp.textPreview)}</div>`) 
      .join('')
    return `<div class="edge"><div><strong>${from}</strong> -${e.polarity === '+' ? '+' : '−'}-> <strong>${to}</strong> (conf ${e.confidence.toFixed(2)})</div>${ev}</div>`
  })
  .join('\n')}`
  await atomicWrite(p, html)
  return p
}

export async function exportCLD(dir: string, base: string, graph: Graph) {
  const nodes = graph.variables.map((v) => v.label)
  const relationships = graph.edges.map((e) => ({
    subject: labelFor(graph, e.fromVariableId),
    predicate: e.polarity === '+' ? '+' : '-',
    object: labelFor(graph, e.toVariableId)
  }))
  const res = await exportMermaid(dir, base, nodes, relationships)
  return res
}

function labelFor(graph: Graph, id: string) {
  const v = graph.variables.find((x) => x.id === id)
  return v ? v.label : id
}

function csv(s: string) {
  return '"' + s.replace(/"/g, '""') + '"'
}

function escapeHtml(s: string) {
  return s.replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export async function exportAll(
  dir: string,
  base: string,
  graph: Graph,
  loops: Loop[]
): Promise<import('./types').ExportBundle> {
  const graphJsonPath = await exportGraphJson(dir, base, { ...graph, edges: graph.edges })
  const { nodesPath: csvNodesPath, edgesPath: csvEdgesPath } = await exportCsv(dir, base, graph.variables, graph.edges)
  const provPath = await exportProvenanceHtml(dir, base, graph.edges, graph.variables)
  const cld = await exportCLD(dir, base, graph)
  return {
    graphJsonPath,
    csvNodesPath,
    csvEdgesPath,
    cldSvgPath: cld.svgPath,
    cldPngPath: cld.pngPath,
    provenanceHtmlPath: provPath
  }
}
