#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { extractNodes, extractRelationships, toKumuJSON, transcribeAudioFile } from './audioToDiagram'
import { callLLM } from './llm'

async function cmdTranscribe(input: string, output: string) {
  if (!input || !output) {
    throw new Error('Usage: transcribe <input.ext> <output.txt>')
  }
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)

  const baseName = path.basename(input, path.extname(input))
  const tmpDir = path.resolve('.tmp_ailoop')
  await fsp.mkdir(tmpDir, { recursive: true })
  const transcriptPath = path.join(tmpDir, `${baseName}.txt`)

  const transcript = await transcribeAudioFile(input, transcriptPath)
  await fsp.writeFile(output, transcript, 'utf8')
  console.log('Transcript written to', output)
}

async function ollamaOnce(prompt: string) {
  const resp = await callLLM('', prompt)
  if (!resp.success) throw new Error(resp.error || 'LLM error')
  return String(resp.data ?? '')
}

async function cmdDiagram(input: string, output: string) {
  if (!input || !output) throw new Error('Usage: diagram <input.txt> <output.json>')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)
  const transcript = await fsp.readFile(input, 'utf8')

  const nodesPrompt = `Extract as a comma separated list the concepts in the following document that will be used to build a relational causal loop diagram.\n\n${transcript}`
  const rawNodes = await ollamaOnce(nodesPrompt)
  const nodes = extractNodes(rawNodes)

  const relsPrompt = `Extract as a comma separated list the relationships between the nodes: ${nodes.join(
    ', '
  )} , according to and only according to the following document that will be used to build a relational causal loop diagram. Each relationship must be in the form 'from node-relationship label-to node'.\n\n${transcript}`
  const rawRels = await ollamaOnce(relsPrompt)
  const relationships = extractRelationships(rawRels)

  await fsp.writeFile(output, JSON.stringify({ nodes, relationships }, null, 2), 'utf8')
  console.log('Diagram JSON written to', output)
}

async function cmdKumu(input: string, output: string) {
  if (!input || !output) throw new Error('Usage: kumu <graph.json> <output.json>')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)

  const graph = JSON.parse(await fsp.readFile(input, 'utf8'))
  const nodes: string[] = graph.nodes ?? graph.elements ?? []
  const relationships: string[] = graph.relationships ?? graph.connections ?? []

  if (!Array.isArray(nodes) || !Array.isArray(relationships)) {
    throw new Error("Input graph must contain arrays 'nodes' and 'relationships' (or 'elements'/'connections')")
  }

  const kumu = toKumuJSON(nodes, relationships)
  await fsp.writeFile(output, JSON.stringify(kumu, null, 2), 'utf8')
  console.log('Kumu JSON written to', output)
}

async function main(argv: string[]) {
  const cmd = argv[0]
  try {
    if (cmd === 'transcribe') await cmdTranscribe(argv[1], argv[2])
    else if (cmd === 'diagram') await cmdDiagram(argv[1], argv[2])
    else if (cmd === 'kumu') await cmdKumu(argv[1], argv[2])
    else {
      console.log('Usage: npx <pkg> <command> [args]')
      console.log('Commands:')
      console.log('  transcribe <input.ext> <output.txt>')
      console.log('  diagram <transcript.txt> <graph.json>')
      console.log('  kumu <input.txt> <output.json>')
      process.exit(1)
    }
  } catch (err: any) {
    console.error('Error:', err?.message ?? err)
    process.exit(1)
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
}

export { cmdDiagram, cmdKumu, cmdTranscribe }
