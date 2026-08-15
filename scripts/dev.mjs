#!/usr/bin/env node
/**
 * Dev runner: boots the Vite dev server in-process, then launches Electron
 * pointed at it. Uses Vite's JS API so the project needs no concurrently /
 * wait-on dependencies and there is no race on "is the server up yet".
 */
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electron from 'electron'

const server = await createServer()
await server.listen()

const url = server.resolvedUrls?.local?.[0]
if (!url) {
  console.error('Vite did not report a local URL')
  process.exit(1)
}

console.log(`\n  vite     ${url}`)
console.log('  electron starting…\n')

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url }
})

const shutdown = async code => {
  try { await server.close() } catch { /* already closing */ }
  process.exit(code ?? 0)
}

child.on('close', shutdown)
process.on('SIGINT', () => { child.kill('SIGINT'); shutdown(0) })
process.on('SIGTERM', () => { child.kill('SIGTERM'); shutdown(0) })
