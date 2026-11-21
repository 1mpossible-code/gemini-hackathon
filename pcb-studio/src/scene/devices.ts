// System-scale device models: dev boards, breakouts, motors, batteries, displays.
// Built procedurally from catalog dimensions so every catalog item has a body.
// Local frame: X = item width, Z = item depth (catalog `h`), Y up, origin at the
// bottom centre of the device. Header pins sit along the -Z edge.
import * as THREE from 'three'
import type { CatalogItem } from '@/data/catalog'
import { canvasTexture } from './vendor/textures'
import { b, cyl, marking, materials, mesh } from './packages'

const mask = new Map<number, THREE.Material>()
function maskMat(color: number) {
  let m = mask.get(color)
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.4 })
    mask.set(color, m)
  }
  return m
}
const plasticMat = new Map<number, THREE.Material>()
function plastic(color: number, opts: THREE.MeshPhysicalMaterialParameters = {}) {
  const key = color + (opts.transmission ? 0.5 : 0)
  let m = plasticMat.get(key)
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.48, clearcoat: 0.25, clearcoatRoughness: 0.4, ...opts })
    plasticMat.set(key, m)
  }
  return m
}

/** PCB colour by family — dev boards keep their recognisable mask colours. */
function pcbColor(item: CatalogItem) {
  const id = item.id
  if (id.startsWith('arduino-uno') || id.startsWith('arduino-mega') || id === 'arduino-nano') return 0x0d5f86
  if (id.startsWith('rpi-')) return 0x1d6b3d
  if (id.startsWith('nucleo')) return 0xe8e8e2
  if (id.startsWith('teensy') || id.startsWith('stm32')) return 0x14366e
  if (id === 'l298n' || id === 'a4988') return 0x8a1d1d
  if (id === 'hcsr04' || id === 'relay-1ch' || id === 'uln2003-board') return 0x13407a
  if (id === 'lcd1602' || id === 'pcf8574') return 0x174a2a
  if (item.category === 'sensor') return 0x3a2161
  if (item.category === 'board' || item.category === 'module') return 0x111214
  return 0x123a6e
}

function screenTexture(title: string, color = '#e8f4ff') {
  return canvasTexture(512, 512, (ctx) => {
    ctx.fillStyle = '#020304'
    ctx.fillRect(0, 0, 512, 512)
    ctx.fillStyle = color
    ctx.font = '600 64px "Geist Mono", monospace'
    ctx.fillText(title, 40, 110)
    ctx.font = '400 36px "Geist Mono", monospace'
    ctx.globalAlpha = 0.8
    ctx.fillText('SPD  0.42 m/s', 40, 190)
    ctx.fillText('HDG  271°', 40, 240)
    ctx.fillText('BAT  7.6 V', 40, 290)
    ctx.globalAlpha = 1
    ctx.strokeStyle = color
    ctx.lineWidth = 5
    ctx.beginPath()
    for (let x = 0; x <= 432; x += 8) ctx.lineTo(40 + x, 420 - Math.sin(x / 30) * 34 - Math.sin(x / 11) * 10)
    ctx.stroke()
  }).texture
}

function board(g: THREE.Group, w: number, d: number, t: number, color: number, holes = true) {
  b(g, w, t, d, 0, t / 2, 0, maskMat(color), Math.min(1.2, w / 8, d / 8))
  if (holes && w > 14 && d > 14) {
    const ring = new THREE.RingGeometry(0.9, 1.6, 24)
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const m = new THREE.Mesh(ring, materials.gold)
      m.rotation.x = -Math.PI / 2
      m.position.set(sx * (w / 2 - 2.4), t + 0.01, sz * (d / 2 - 2.4))
      g.add(m)
    }
  }
}

/** Male header row along the -Z edge, pins pointing down (plugs into a cable / breadboard). */
function headerRow(g: THREE.Group, n: number, z: number, t: number, female = false) {
  const len = n * 2.54
  if (female) b(g, len, 8.5, 2.54, 0, t + 4.25, z, materials.plastic, 0.2)
  else b(g, len, 2.5, 2.54, 0, -1.25, z, materials.plastic, 0.2)
  const pin = new THREE.BoxGeometry(0.64, female ? 3 : 8.5, 0.64)
  for (let i = 0; i < n; i++) {
    mesh(g, pin, materials.gold, (i - (n - 1) / 2) * 2.54, female ? t + 0.8 : -2.4, z)
  }
}

function chip(g: THREE.Group, s: number, t: number, label: string, x = 0, z = 0) {
  b(g, s, 1.1, s, x, t + 0.55, z, materials.chip, 0.15)
  marking(g, label, s * 0.9, s * 0.45, t + 1.12, '#8d918c')
}

function smalls(g: THREE.Group, w: number, d: number, t: number, seed: number) {
  const r = (i: number) => ((Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453) % 1 + 1) % 1
  const n = Math.min(10, Math.floor((w * d) / 90))
  for (let i = 0; i < n; i++) {
    const x = (r(i) - 0.5) * (w - 6)
    const z = (r(i + 50) - 0.5) * (d - 8) + 1.5
    if (Math.abs(x) < w * 0.22 && Math.abs(z) < d * 0.22) continue
    const rot = r(i + 9) > 0.5
    b(g, rot ? 0.8 : 1.6, 0.45, rot ? 1.6 : 0.8, x, t + 0.23, z, i % 3 ? materials.ceramic : materials.resistor, 0.05)
  }
}

function seedOf(id: string) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 997
  return h + 1
}

function shortMark(item: CatalogItem) {
  return item.mpn.split(/[\s/(]/)[0].slice(0, 10)
}

// ——— specials ————————————————————————————————————————————————

function gearMotor(g: THREE.Group, item: CatalogItem) {
  const { w, h } = item.dimensions
  const yellow = plastic(item.id.startsWith('tt') ? 0xc9a227 : 0x8d9296, item.id.startsWith('tt') ? {} : { metalness: 0.9, roughness: 0.3 })
  const r = h / 2
  if (item.id.startsWith('tt')) {
    b(g, w * 0.62, h, h * 0.86, -w * 0.12, r, 0, yellow, 1.5) // gearbox
    const can = cyl(g, r * 0.88, w * 0.36, w * 0.32, r, 0, materials.silver)
    can.rotation.z = Math.PI / 2
  } else {
    const gb = cyl(g, r, w * 0.45, -w * 0.18, r, 0, materials.silver)
    gb.rotation.z = Math.PI / 2
    const can = cyl(g, r * 0.92, w * 0.5, w * 0.27, r, 0, materials.tin)
    can.rotation.z = Math.PI / 2
  }
  // shaft + wheel on the -X side; the wheel lives in its own group so it can spin
  const shaft = cyl(g, 1.5, 14, -w * 0.43 - 7, r, 0, materials.gold, 16)
  shaft.rotation.z = Math.PI / 2
  const wheelR = Math.max(16, h * 1.45)
  const wheel = new THREE.Group()
  wheel.name = 'wheel'
  wheel.position.set(-w * 0.43 - 20, r, 0)
  g.add(wheel)
  const tyre = mesh(wheel, new THREE.CylinderGeometry(wheelR, wheelR, 26, 64), materials.rubber, 0, 0, 0)
  tyre.rotation.z = Math.PI / 2
  const hub = mesh(wheel, new THREE.CylinderGeometry(wheelR * 0.62, wheelR * 0.62, 27, 6), plastic(0xd9d9d2), 0, 0, 0)
  hub.rotation.z = Math.PI / 2
  const rib = new THREE.BoxGeometry(24, 1.4, 2.4)
  for (let i = 0; i < 30; i++) {
    const a = (i / 30) * Math.PI * 2
    const m = mesh(wheel, rib, materials.rubber, 0, Math.sin(a) * wheelR, Math.cos(a) * wheelR)
    m.rotation.x = -a
  }
}

function battery(g: THREE.Group, item: CatalogItem) {
  const { w, h, thickness } = item.dimensions
  b(g, w, thickness * 0.55, h, 0, thickness * 0.275, 0, materials.plastic, 0.8)
  for (const sx of [-1, 1]) b(g, 1.2, thickness * 0.9, h * 0.9, sx * (w / 2 - 0.6), thickness * 0.45, 0, materials.plastic, 0.3)
  const cell = cyl(g, 9, 65, 0, 10, 0, plastic(0x1f5e43, { clearcoat: 0.8, roughness: 0.25 }))
  cell.rotation.z = Math.PI / 2
  const cap = cyl(g, 4, 1.2, 33, 10, 0, materials.silver)
  cap.rotation.z = Math.PI / 2
  for (const sx of [-1, 1]) b(g, 0.6, 9, 7, sx * (w / 2 - 2), 8, 0, materials.silver, 0.1)
}

function sonar(g: THREE.Group, item: CatalogItem) {
  const { w, h } = item.dimensions
  board(g, w, h, 1.6, pcbColor(item), false)
  for (const sx of [-1, 1]) {
    cyl(g, 8, 12, sx * 13, 1.6 + 6, 1, materials.silver)
    cyl(g, 7.2, 0.4, sx * 13, 1.6 + 12.1, 1, materials.rubber)
  }
  b(g, 5, 2, 3, 0, 2.6, 4, materials.silver, 0.4) // crystal
  headerRow(g, 4, -h / 2 + 1.6, 1.6)
}

function servo(g: THREE.Group, item: CatalogItem) {
  const { w, h, thickness } = item.dimensions
  const blue = plastic(0x1f5fbf, { transmission: 0.25, thickness: 2, roughness: 0.35 })
  b(g, w, thickness, h, 0, thickness / 2, 0, blue, 0.8)
  b(g, 32, 2.4, h, 0, thickness * 0.72, 0, blue, 0.4)
  cyl(g, 5.8, 5, w / 2 - 6, thickness + 2.5, 0, blue)
  cyl(g, 2.4, 3, w / 2 - 6, thickness + 6, 0, plastic(0xe8e8e2))
  b(g, 20, 1.6, 5, w / 2 - 6, thickness + 7.2, 0, plastic(0xe8e8e2), 1.2)
}

function stepper(g: THREE.Group, item: CatalogItem) {
  const { w, thickness } = item.dimensions
  cyl(g, w / 2, thickness, 0, thickness / 2, 0, materials.silver)
  b(g, 16, thickness * 0.8, 6, 0, thickness * 0.4, -w / 2 - 1, plastic(0x1f5fbf), 0.6)
  cyl(g, 4.5, 1.5, 0, thickness + 0.75, 8, materials.silver)
  cyl(g, 2.5, 9, 0, thickness + 4.5, 8, materials.gold, 16)
}

function ledStrip(g: THREE.Group, item: CatalogItem) {
  const len = Math.min(item.dimensions.w, 140)
  const d = item.dimensions.h
  b(g, len, 0.6, d, 0, 0.3, 0, plastic(0xf1f1ec), 0.2)
  const led = new THREE.BoxGeometry(5, 1.6, 5)
  const glow = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdfe8ff, emissiveIntensity: 2.2, roughness: 0.3 })
  for (let x = -len / 2 + 8; x < len / 2 - 4; x += 16.6) {
    mesh(g, led, glow, x, 1.4, 0)
    b(g, 1.6, 0.5, 1, x + 6, 0.85, 0, materials.ceramic, 0.05)
  }
}

function display(g: THREE.Group, item: CatalogItem) {
  const { w, h } = item.dimensions
  const t = 1.6
  board(g, w, h, t, pcbColor(item))
  const sw = w * 0.92
  const sd = h * 0.66
  b(g, sw, 1.6, sd, 0, t + 0.8, 1.5, materials.chip, 0.2)
  const tex = screenTexture(item.id.startsWith('lcd') ? 'FORGE' : 'FORGE·RVR', item.id.startsWith('lcd') ? '#d7f5ff' : '#e8f4ff')
  const screen = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.15 })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(sw * 0.86, sd * 0.78), screen)
  m.rotation.x = -Math.PI / 2
  m.position.set(0, t + 1.62, 1.5)
  g.add(m)
  headerRow(g, Math.max(4, Math.min(8, item.pins.length || 4)), -h / 2 + 1.8, t)
}

function devBoard(g: THREE.Group, item: CatalogItem) {
  const { w, h } = item.dimensions
  const t = item.dimensions.thickness > 3 ? 1.6 : item.dimensions.thickness
  board(g, w, h, t, pcbColor(item))
  const id = item.id
  const arduinoStyle = id.startsWith('arduino-uno') || id.startsWith('arduino-mega')
  const rpi = id.startsWith('rpi-') && !id.includes('pico')
  // edge headers
  const along = Math.max(4, Math.floor((w - 6) / 2.54))
  if (arduinoStyle) {
    for (const sz of [-1, 1]) {
      const n = Math.floor(along * 0.42)
      const gr = new THREE.Group()
      headerRow(gr, n, 0, t, true)
      gr.position.set(sz < 0 ? -w * 0.12 : w * 0.1, 0, sz * (h / 2 - 2.6))
      g.add(gr)
    }
  } else if (rpi) {
    const gr = new THREE.Group()
    headerRow(gr, 20, 0, t, false)
    gr.position.set(0, t + 9, -h / 2 + 3.5)
    gr.rotation.x = Math.PI
    g.add(gr)
    const gr2 = gr.clone()
    gr2.position.z += 2.54
    g.add(gr2)
  } else {
    for (const sz of [-1, 1]) {
      const gr = new THREE.Group()
      headerRow(gr, along, 0, t)
      gr.position.set(0, 0, sz * (h / 2 - 1.4))
      g.add(gr)
    }
  }
  const esp = id.includes('esp') || id.includes('nodemcu') || id.includes('xiao')
  if (esp) {
    const mw = Math.min(18, w * 0.55)
    const md = Math.min(18, h * 0.62)
    b(g, mw, 0.8, md, w * 0.12, t + 0.4, 0, materials.moduleBoard, 0.2)
    b(g, mw * 0.84, 2.4, md * 0.7, w * 0.12, t + 2, md * 0.1, materials.stamped, 0.25)
    marking(g, 'ESP32', mw * 0.7, md * 0.3, t + 3.22, '#3c3f40')
  } else {
    chip(g, Math.min(10, Math.min(w, h) * 0.32), t, shortMark(item), w * 0.05, 0)
  }
  if (rpi) {
    for (let i = 0; i < 2; i++) b(g, 14, 15.5, 13, w / 2 - 8, t + 7.75, -h / 2 + 12 + i * 18, materials.silver, 0.6)
    b(g, 16, 13.5, 21, w / 2 - 9, t + 6.75, h / 2 - 13, materials.silver, 0.6)
  }
  // USB on the -X edge
  b(g, 7.5, 3, 9, -w / 2 + 3.2, t + 1.5, 0, materials.silver, 0.8)
  if (arduinoStyle) {
    b(g, 12, 11, 16, -w / 2 + 6, t + 5.5, -h / 2 + 12, materials.silver, 0.4)
    b(g, 9, 11, 14, -w / 2 + 4.5, t + 5.5, h / 2 - 9, materials.plastic, 0.6)
  }
  b(g, 3.2, 1.2, 1.6, -w / 2 + 12, t + 0.6, h / 2 - 5, materials.ledLens, 0.1)
  smalls(g, w, h, t, seedOf(id))
}

function breakout(g: THREE.Group, item: CatalogItem) {
  const { w, h } = item.dimensions
  const t = 1.6
  board(g, w, h, t, pcbColor(item))
  const s = Math.max(3, Math.min(w, h) * (item.category === 'power' || item.category === 'driver' ? 0.36 : 0.24))
  chip(g, s, t, shortMark(item), 0, 1.5)
  if (item.id === 'l298n') {
    for (let i = 0; i < 9; i++) b(g, 1.4, 22, 18, -9 + i * 2.3, t + 11, 0, materials.silver, 0.2)
  }
  if (item.id === 'relay-1ch') b(g, 19, 15.5, 15.5, w * 0.12, t + 7.75, 1, plastic(0x1f4fa8), 0.6)
  if (item.id === 'lm2596' || item.id === 'mt3608' || item.id === 'xl6009') {
    cyl(g, 6, 7, w * 0.25, t + 3.5, 0, materials.plastic)
    b(g, 10, 6, 10, -w * 0.22, t + 3, 0, materials.chip, 1.5)
    b(g, 9.5, 10, 4.5, w * 0.05, t + 5, h / 2 - 4, plastic(0x2c5fb5), 0.4)
  }
  if (item.category === 'comms' && w > 25) {
    b(g, w * 0.55, 2.4, h * 0.5, w * 0.1, t + 1.2, 0, materials.stamped, 0.2)
  }
  const n = Math.max(2, Math.min(Math.floor((w - 2) / 2.54), item.pins.length || 4))
  headerRow(g, n, -h / 2 + 1.6, t)
  smalls(g, w, h, t, seedOf(item.id))
}

/** Build a device body for any catalog item. */
export function buildDevice(item: CatalogItem): THREE.Group {
  const g = new THREE.Group()
  const id = item.id
  if (item.category === 'actuator' && item.footprint.kind === 'terminal') gearMotor(g, item)
  else if (id === 'sg90') servo(g, item)
  else if (id === '28byj-48') stepper(g, item)
  else if (id.startsWith('holder-18650')) battery(g, item)
  else if (id === 'hcsr04') sonar(g, item)
  else if (id.startsWith('ws2812b-strip')) ledStrip(g, item)
  else if (item.category === 'display' && !id.startsWith('ws2812') && !id.startsWith('max7219')) display(g, item)
  else if (item.category === 'board') devBoard(g, item)
  else breakout(g, item)
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
  const box = new THREE.Box3().setFromObject(g)
  g.userData.height = box.max.y
  return g
}
