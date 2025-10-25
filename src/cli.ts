#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  downloadYoutubeAudio,
  generateNodes,
  generateRelationships,
  toKumuJSON,
  toMermaid,
  transcribeAudioFile
} from './audioToDiagram'

async function cmdTranscribe(input: string, output: string) {
  if (!input || !output) {
    throw new Error('Usage: transcribe <input.ext> <output.txt>')
  }

  let audioPath = input

  // Download
  if (input.includes('youtube.com') || input.includes('youtu.be')) {
    await downloadYoutubeAudio(input, output.replace(/\.txt$/i, '.wav'))
    audioPath = output.replace(/\.txt$/i, '.wav')
  }

  if (!fs.existsSync(audioPath)) throw new Error(`Input not found: ${audioPath}`)

  const baseName = path.basename(audioPath, path.extname(audioPath))
  const tmpDir = os.tmpdir()
  await fsp.mkdir(tmpDir, { recursive: true })
  const transcriptPath = path.join(tmpDir, `${baseName}.txt`)

  const transcript = await transcribeAudioFile(audioPath, transcriptPath)
  await fsp.writeFile(output, transcript, 'utf8')
  console.log('Transcript written to', output)
}

async function cmdDiagram(input: string, output: string) {
  if (!input || !output) throw new Error('Usage: diagram <input.txt> <output.json>')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)
  const transcript = await fsp.readFile(input, 'utf8')

  const nodes = await generateNodes(transcript)
  const relationships = await generateRelationships(transcript, nodes)

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

async function cmdMermaid(input: string, output: string) {
  if (!input || !output) throw new Error('Usage: mermaid <graph.json> <output.mmd>')
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)

  const graph = JSON.parse(await fsp.readFile(input, 'utf8'))
  const nodes: string[] = graph.nodes ?? graph.elements ?? []
  const relationships: string[] = graph.relationships ?? graph.connections ?? []

  if (!Array.isArray(nodes) || !Array.isArray(relationships)) {
    throw new Error("Input graph must contain arrays 'nodes' and 'relationships' (or 'elements'/'connections')")
  }

  // Convert to mermaid syntax
  const mermaid = toMermaid(nodes, relationships)
  await fsp.writeFile(output, mermaid, 'utf8')
  console.log('Mermaid diagram written to', output)
}

async function main(argv: string[]) {
  const cmd = argv[0]
  try {
    if (cmd === 'transcribe') await cmdTranscribe(argv[1], argv[2])
    else if (cmd === 'diagram') await cmdDiagram(argv[1], argv[2])
    else if (cmd === 'kumu') await cmdKumu(argv[1], argv[2])
    else if (cmd === 'mermaid') await cmdMermaid(argv[1], argv[2])
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
