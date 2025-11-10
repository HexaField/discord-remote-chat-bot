import childProcess from 'node:child_process'
import path from 'path'
import { extractVariables } from '../cld'
import { atomicWrite } from '../utils'

export async function exportGraphViz(dir: string, baseName: string, statements: string[]): Promise<void> {
  const dot = generateDot(statements)
  // Write to .dot file
  const outputPath = path.join(dir, `${baseName}.dot`)
  await atomicWrite(outputPath, dot)
  // use dot command to generate SVG
  const svgPath = path.join(dir, `${baseName}.svg`)
  await new Promise<void>((resolve, reject) => {
    const dotProcess = childProcess.spawn('dot', ['-Tsvg', outputPath, '-o', svgPath])
    dotProcess.on('error', (err) => {
      reject(err)
    })
    dotProcess.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`dot process exited with code ${code}`))
      }
    })
  })

  // use dot command to generate PNG
  const pngPath = path.join(dir, `${baseName}.png`)
  await new Promise<void>((resolve, reject) => {
    const dotProcess = childProcess.spawn('dot', ['-Tpng', outputPath, '-o', pngPath])
    dotProcess.on('error', (err) => {
      reject(err)
    })
    dotProcess.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`dot process exited with code ${code}`))
      }
    })
  })
}

function generateDot(statements: string[]) {
  console.log(statements)
  let dot = 'digraph G {\n  rankdir=LR;\n  node [shape=box];\n'
  for (const line of statements) {
    const [v1, v2, symbol] = extractVariables(line)
    if (!v1 || !v2 || v1 === v2) continue
    const label = symbol || ''
    dot += `  \"${v1}\" -> \"${v2}\" [label=\"${label}\"];\n`
  }
  dot += '}\n'
  return dot
}
