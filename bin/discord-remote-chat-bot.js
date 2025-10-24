#!/usr/bin/env node
/* Thin wrapper that prefers a compiled CLI at ./dist/cli.js, otherwise tries to run the TypeScript CLI at ./src/cli.ts using ts-node/register. */
const path = require('path')
const fs = require('fs')

const projectRoot = path.resolve(__dirname, '..')
const distCli = path.join(projectRoot, 'dist', 'cli.js')

if (fs.existsSync(distCli)) {
  require(distCli)
} else {
  try {
    // Try to enable ts-node so we can require the TS source directly.
    require('ts-node/register')
    require(path.join(projectRoot, 'src', 'cli.ts'))
  } catch (err) {
    console.error(
      'Failed to launch CLI. Either run `npm run build` to generate `dist/cli.js` or install `ts-node` to run the TypeScript sources.'
    )
    console.error('Underlying error:', err && err.message ? err.message : err)
    process.exit(1)
  }
}
