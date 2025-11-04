import childProcess from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

function sanitizeId(s: string) {
  return s.replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'N'
}

async function atomicWrite(filePath: string, data: string) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const tmp = path.join(dir, `.${base}.partial`)
  await fsp.writeFile(tmp, data, 'utf8')
  await fsp.rename(tmp, filePath)
}
/**
 * Builds a Mermaid diagram definition from the given nodes and relationships.
 * @param nodes The nodes to include in the diagram.
 * @param relationships The relationships between the nodes.
 * @returns The Mermaid diagram definition as a string.
 */
export function buildMermaid(
  nodes: string[],
  relationships: Array<{ subject: string; predicate: string; object: string }>
) {
  const sanitize = sanitizeId
  const uniqueNodes = Array.from(new Set(nodes))
  const nodeLines = uniqueNodes.map((n) => `${sanitize(n)}["${n.replace(/\"/g, '\\"')}"]`)

  const edgeLines: string[] = []
  for (const rel of relationships) {
    if (!rel || typeof rel !== 'object') continue
    const from = rel.subject || ''
    const to = rel.object || ''
    const label = rel.predicate || ''
    if (from && to) edgeLines.push(`${sanitize(from)} -- "${String(label).replace(/\"/g, '\\"')}" --> ${sanitize(to)}`)
  }

  return ['graph TD', ...nodeLines, ...edgeLines].join('\n') + '\n'
}

/**
 * Exports the given nodes and relationships as a Mermaid diagram file and attempts to render an SVG.
 * @param dir The output directory.
 * @param baseName The base name for the output files (without extension).
 * @param nodes The nodes to include in the diagram.
 * @param relationships The relationships between the nodes.
 * @returns An object containing the paths to the generated files.
 */
export async function exportMermaid(
  dir: string,
  baseName: string,
  nodes: string[],
  relationships: Array<{ subject: string; predicate: string; object: string }>
) {
  await fsp.mkdir(dir, { recursive: true })

  const chart = buildMermaid(nodes, relationships)

  const outPath = path.join(dir, `${baseName}.mdd`)
  const svgPath = path.join(dir, `${baseName}.svg`) as `${string}.svg`

  await atomicWrite(outPath, chart)
  try {
    // Invoke mermaid cli since using it as a dependency errors

    await new Promise<void>((resolve, reject) => {
      const cmd = `mmdc -i ${outPath} -o ${svgPath}`
      let settled = false
      const cp = childProcess.exec(cmd, (error, stdout, stderr) => {
        if (error) {
          if (!settled) {
            settled = true
            reject(error)
          }
          return
        }
        if (stderr) console.error(`stderr: ${stderr}`)
        if (stdout) {
          console.log(`stdout: ${stdout}`)
          if (stdout.includes('Generating single mermaid chart')) {
            resolve()
            cp.kill()
          }
        }
      })

      // interval to check for svg file write
      setInterval(() => {
        fsp
          .access(svgPath)
          .then(() => {
            if (!settled) {
              settled = true
              resolve()
              cp.kill()
            }
          })
          .catch(() => {
            // not yet written
          })
      }, 500)

      cp.on('close', (code, signal) => {
        if (settled) return
        settled = true
        if (code !== 0) {
          reject(new Error(`mmdc exited with code ${code}${signal ? ` signal ${signal}` : ''}`))
        } else {
          resolve()
        }
      })

      cp.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
    })
    /** @todo implement PNG rendering see https://github.com/mermaid-js/mermaid/issues/6634 */
    // const resvg = new Resvg(svg)
    // const pngData = resvg.render()
    // const pngBuffer = pngData.asPng()
    // const pngPath = path.join(dir, `${baseName}.png`) as `${string}.png`
    // atomicWrite(pngPath, pngBuffer)
    return { outPath, svgPath }
  } catch (e: any) {
    console.warn('mermaid SVG render failed:', e?.message ?? e)
  }

  return { outPath }
}

export default exportMermaid
