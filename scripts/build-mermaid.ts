import { buildMermaid } from '../src/exporters/mermaidExporter'

async function main() {
  const arg = process.argv[2]
  if (!arg) throw new Error('Expected JSON input as first argument')

  const { nodes = [], relationships = [] } = JSON.parse(arg)
  const output = buildMermaid(nodes, relationships)
  process.stdout.write(output)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
