// Adapted from STC-B Board 3D Viewer (Apache-2.0), https://github.com/DeliciousBuding/stcb-board-3d-viewer
// SPDX-License-Identifier: Apache-2.0
import * as THREE from 'three'

export function canvasTexture(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  paint(ctx)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 16
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  return { canvas, ctx, texture }
}

export function createMarkingTexture(text: string, color = '#b7bcb1') {
  return canvasTexture(1024, 512, (ctx) => {
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const lines = text.split('\n')
    const size = Math.min(112, 748 / Math.max(...lines.map((line) => line.length)) * 1.65)
    ctx.font = `600 ${size}px Arial, sans-serif`
    lines.forEach((line, index) => ctx.fillText(line, 512, 256 + (index - (lines.length - 1) / 2) * (size + 20)))
  }).texture
}

/** Compact markings have their own scale; IC-label padding made 0805 codes illegibly tiny. */
export function createPassiveMarkingTexture(code: string) {
  return canvasTexture(512, 256, ctx => {
    ctx.fillStyle = '#c3c8b8'; ctx.font = '600 196px Arial, sans-serif'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(code, 256, 132, 468)
  }).texture
}

export function createRoundTexture(kind: 'battery' | 'capacitor' | 'ldr' | 'buzzer', relief = false) {
  return canvasTexture(512, 512, (ctx) => {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (kind === 'ldr') {
      ctx.fillStyle = '#d5b581'
      ctx.fillRect(0, 0, 512, 512)
      ctx.strokeStyle = '#653f24'
      ctx.lineWidth = 16
      ctx.lineCap = 'round'
      ctx.beginPath()
      // The photo shows a single serpentine electrode, not two ladder rails.
      ctx.moveTo(120, 100); ctx.lineTo(352, 100)
      for (let i = 0; i < 5; i++) {
        const y = 100 + i * 60, right = i % 2 === 0
        const x = right ? 352 : 160
        ctx.bezierCurveTo(x + (right ? 36 : -36), y, x + (right ? 36 : -36), y + 60, x, y + 60)
        ctx.lineTo(right ? 160 : 352, y + 60)
      }
      ctx.stroke()

    } else {
      ctx.fillStyle = relief ? '#888888' : kind === 'battery' ? '#9b9b8e' : kind === 'capacitor' ? '#b8bdb7' : '#121314'
      ctx.fillRect(0, 0, 512, 512)
      ctx.strokeStyle = relief ? '#505050' : kind === 'buzzer' ? '#252729' : '#74766a'
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.arc(256, 256, 226, 0, Math.PI * 2); ctx.stroke()
      ctx.fillStyle = relief ? '#444444' : kind === 'buzzer' ? '#585b50' : kind === 'battery' ? '#797c70' : '#414942'
      if (kind === 'battery') {
        ctx.font = '72px Consolas'; ctx.fillText('+', 256, 100)
        ctx.font = '48px Consolas'; ctx.fillText('CR1220', 256, 230)
        ctx.font = '40px Consolas'; ctx.fillText('3V', 256, 312)
        ctx.font = '24px Consolas'; ctx.fillText('LITHIUM CELL', 256, 377)
      } else if (kind === 'capacitor') {
        // Assembly photo reads 100; schematic p6 specifies 220 uF. Do not invent a voltage rating.
        ctx.font = '92px Consolas'; ctx.fillText('100', 280, 260)
        ctx.beginPath(); ctx.arc(256, 256, 228, Math.PI * 0.73, Math.PI * 1.27); ctx.closePath(); ctx.fill()
      } else {
        ctx.font = '72px Consolas'; ctx.fillText('+', 352, 112)
        ctx.font = '38px Consolas'; ctx.fillText('BZ', 167, 152)
      }
    }
  }).texture
}

let ledGlow: THREE.Texture | undefined
export function createLedGlowTexture() {
  ledGlow ??= canvasTexture(64, 64, ctx => {
    const glow = ctx.createRadialGradient(32, 32, 1, 32, 32, 32)
    glow.addColorStop(0, 'rgba(255,255,255,0.6)')
    glow.addColorStop(0.35, 'rgba(255,255,255,0.12)')
    glow.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = glow; ctx.fillRect(0, 0, 64, 64)
  }).texture
  return ledGlow
}
