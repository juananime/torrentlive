#!/usr/bin/env node
/**
 * Renders build/icon.png (1024×1024) with Electron's own renderer, so the
 * project needs no image-processing dependency. electron-builder converts
 * that single PNG into .icns for macOS and .ico for Windows by itself.
 *
 * Run: npm run icon
 */
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')

// The session view reduced to its essentials: stacked meters at different
// fill levels, in Live's yellow with one green "downloading" bar.
const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; width: 1024px; height: 1024px; background: transparent; }
  .plate {
    position: absolute; inset: 44px;
    background: #1c1c1c;
    border-radius: 180px;
    border: 8px solid #0c0c0c;
    display: flex; flex-direction: column;
    justify-content: center; gap: 62px;
    padding: 0 150px;
  }
  .bar { height: 78px; background: #101010; border: 6px solid #3a3a3a; position: relative; }
  .bar i { position: absolute; inset: 0 auto 0 0; }
</style>
<div class="plate">
  <div class="bar"><i style="width:78%;background:#ffe900"></i></div>
  <div class="bar"><i style="width:46%;background:#79d13b"></i></div>
  <div class="bar"><i style="width:92%;background:#ffe900"></i></div>
  <div class="bar"><i style="width:22%;background:#35a3e8"></i></div>
</div>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise(r => setTimeout(r, 600))

  const img = await win.webContents.capturePage()
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, img.toPNG())

  const { width, height } = img.getSize()
  console.log(`wrote ${out} (${width}×${height})`)
  app.exit(0)
})
