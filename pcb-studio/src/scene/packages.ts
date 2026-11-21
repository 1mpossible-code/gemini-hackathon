// Component package models.
// Materials, helpers and several package shapes adapted from STC-B Board 3D Viewer
// (Apache-2.0), https://github.com/DeliciousBuding/stcb-board-3d-viewer — see vendor/STCB-LICENSE.txt
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { Part } from '@/data/board'
import { bodyFor, padsFor } from '@/pcb/footprint'
import { surfaceMap } from './vendor/surface-maps'
import { canvasTexture, createMarkingTexture, createPassiveMarkingTexture } from './vendor/textures'
import { solderJointGeometry } from './vendor/detail-geometry'

// Group-local frame: X = part local x, Z = part local y (toward board front), Y = up from board top.

export const materials = {
  plastic: new THREE.MeshPhysicalMaterial({ color: 0x151719, roughness: 0.52, clearcoat: 0.22, clearcoatRoughness: 0.48, bumpMap: surfaceMap('grain'), bumpScale: 0.008 }),
  plasticGrey: new THREE.MeshPhysicalMaterial({ color: 0x2a2d31, roughness: 0.6, clearcoat: 0.12, clearcoatRoughness: 0.5, bumpMap: surfaceMap('grain'), bumpScale: 0.01 }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.92 }),
  chip: new THREE.MeshPhysicalMaterial({ color: 0x1b1d20, roughness: 0.62, clearcoat: 0.18, clearcoatRoughness: 0.42, bumpMap: surfaceMap('grain'), bumpScale: 0.006 }),
  silver: new THREE.MeshStandardMaterial({ color: 0xb7bdc0, roughness: 0.34, metalness: 1, envMapIntensity: 1.25, roughnessMap: surfaceMap('brushed'), bumpMap: surfaceMap('brushed'), bumpScale: 0.0025 }),
  solder: new THREE.MeshStandardMaterial({ color: 0xa3aaad, roughness: 0.38, metalness: 1, envMapIntensity: 1.2, bumpMap: surfaceMap('grain'), bumpScale: 0.004 }),
  stamped: new THREE.MeshStandardMaterial({ color: 0xb8b9ad, roughness: 0.38, metalness: 1 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xbe994e, roughness: 0.3, metalness: 1, envMapIntensity: 1.2 }),
  tin: new THREE.MeshStandardMaterial({ color: 0xc9cdd0, roughness: 0.28, metalness: 1, envMapIntensity: 1.3 }),
  ceramic: new THREE.MeshStandardMaterial({ color: 0x9c8a6c, roughness: 0.58 }),
  resistor: new THREE.MeshStandardMaterial({ color: 0x141516, roughness: 0.66 }),
  moduleBoard: new THREE.MeshPhysicalMaterial({ color: 0x101113, roughness: 0.7, clearcoat: 0.2, clearcoatRoughness: 0.5 }),
  ivory: new THREE.MeshPhysicalMaterial({ color: 0xd8d8d0, roughness: 0.55, clearcoat: 0.1 }),
  ledLens: new THREE.MeshPhysicalMaterial({ color: 0xf2f4f5, roughness: 0.12, transmission: 0.55, thickness: 0.4, transparent: true, opacity: 0.92 }),
}

const boxCache = new Map<string, THREE.BufferGeometry>()
function block(w: number, h: number, d: number, radius = 0.04) {
  const key = [w, h, d, radius].map((v) => v.toFixed(3)).join()
  let g = boxCache.get(key)
  if (!g) {
    const r = Math.min(radius, w / 2.01, h / 2.01, d / 2.01)
    g = r > 0.001 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d)
    boxCache.set(key, g)
  }
  return g
}

function mesh(g: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(geo, mat)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  g.add(m)
  return m
}
const b = (g: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, r = 0.04) =>
  mesh(g, block(w, h, d, r), mat, x, y, z)
function cyl(g: THREE.Object3D, r: number, h: number, x: number, y: number, z: number, mat: THREE.Material, seg = 48) {
  return mesh(g, new THREE.CylinderGeometry(r, r, h, seg), mat, x, y, z)
}

const decalCache = new Map<string, THREE.Material>()
function topFace(g: THREE.Object3D, w: number, d: number, y: number, tex: THREE.Texture, key: string) {
  let mat = decalCache.get(key)
  if (!mat) {
    mat = new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.68, transparent: true, alphaTest: 0.2, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, clearcoat: 0.1,
    })
    decalCache.set(key, mat)
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat)
  m.rotation.x = -Math.PI / 2
  m.position.y = y
  g.add(m)
  return m
}
const marking = (g: THREE.Object3D, text: string, w: number, d: number, y: number, color = '#9a9d98') =>
  topFace(g, w, d, y, createMarkingTexture(text, color), `mark:${text}:${color}`)

/** Gull-wing lead: profile in XY extruded along Z; extends +x from the body edge. (STC-B) */
let gullwingGeo: THREE.BufferGeometry | null = null
function gullwing() {
  if (gullwingGeo) return gullwingGeo
  const s = new THREE.Shape()
  s.moveTo(0, 0.78); s.lineTo(0.36, 0.78); s.lineTo(0.73, 0.2); s.lineTo(1.22, 0.2)
  s.lineTo(1.22, 0.04); s.lineTo(0.62, 0.04); s.lineTo(0.25, 0.62); s.lineTo(0, 0.62)
  gullwingGeo = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5)
  return gullwingGeo
}

function stamped(g: THREE.Object3D, w: number, d: number, t: number, y: number, holes: { x: number; z: number; r: number }[], mat = materials.stamped) {
  const shape = new THREE.Shape()
  const r = 0.2
  shape.moveTo(-w / 2 + r, -d / 2); shape.lineTo(w / 2 - r, -d / 2); shape.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r)
  shape.lineTo(w / 2, d / 2 - r); shape.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2); shape.lineTo(-w / 2 + r, d / 2)
  shape.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r); shape.lineTo(-w / 2, -d / 2 + r); shape.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2)
  for (const h of holes) {
    const p = new THREE.Path()
    p.absarc(h.x, -h.z, h.r, 0, Math.PI * 2, true)
    shape.holes.push(p)
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 24 }).rotateX(-Math.PI / 2)
  return mesh(g, geo, mat, 0, y, 0)
}

// ---------------------------------------------------------------- packages

function icLeads(g: THREE.Object3D, p: Part, bodyHalfW: number, legW: number) {
  const pads = padsFor(p)
  const geo = gullwing()
  for (const pad of pads) {
    const leg = new THREE.Mesh(geo, materials.tin)
    const dir = pad.x > 0 ? 1 : -1
    leg.scale.set(Math.abs(pad.x) - bodyHalfW + 0.35 > 0 ? (Math.abs(pad.x) - bodyHalfW + 0.45) / 1.22 : 1, 1, legW)
    leg.position.set(dir * (bodyHalfW - 0.05), 0, pad.y)
    leg.rotation.y = dir > 0 ? 0 : Math.PI
    leg.castShadow = true
    g.add(leg)
  }
}

function soicLike(g: THREE.Group, p: Part) {
  const body = bodyFor(p)
  const legW = p.kind === 'ssop' ? 0.26 : 0.42
  b(g, body.w, body.height - 0.15, body.h, 0, (body.height - 0.15) / 2 + 0.15, 0, materials.chip, 0.12)
  icLeads(g, p, body.w / 2, legW)
  // pin-1 dimple + laser marking
  cyl(g, 0.32, 0.04, -body.w / 2 + 0.85, body.height + 0.005, -body.h / 2 + 0.95, materials.rubber, 24)
  const label = p.kind === 'ssop' ? `${p.name}\n8EL  2547` : `${p.name}\n2541 A3`
  marking(g, label, body.w * 0.82, body.w * 0.41, body.height + 0.012)
}

function sot223(g: THREE.Group, p: Part) {
  const body = bodyFor(p)
  b(g, body.w, body.height - 0.15, body.h, 0, (body.height - 0.15) / 2 + 0.15, 0, materials.chip, 0.12)
  // tab across the back, three legs to the front
  b(g, 3.0, 0.25, 1.9, 0, 0.13, -body.h / 2 - 0.7, materials.tin, 0.03)
  b(g, 3.0, 0.25, 0.9, 0, 0.5, -body.h / 2 + 0.2, materials.tin, 0.03)
  for (const x of [-2.3, 0, 2.3]) {
    b(g, 0.7, 0.22, 1.2, x, 0.4, body.h / 2 + 0.45, materials.tin, 0.03)
    b(g, 0.7, 0.2, 1.0, x, 0.11, body.h / 2 + 1.05, materials.tin, 0.03)
  }
  marking(g, 'AMS1117\n3.3  2540', body.w * 0.8, body.w * 0.4, body.height + 0.012)
}

let antennaTex: THREE.Texture | null = null
function moduleAntenna() {
  if (antennaTex) return antennaTex
  antennaTex = canvasTexture(512, 256, (ctx) => {
    ctx.strokeStyle = '#a38c55'
    ctx.lineWidth = 9
    ctx.lineJoin = 'miter'
    ctx.beginPath()
    let x = 40
    ctx.moveTo(x, 230)
    ctx.lineTo(x, 40)
    for (let i = 0; i < 7; i++) {
      x += 30
      ctx.lineTo(x, 40)
      ctx.lineTo(x, i % 2 ? 40 : 190)
      ctx.lineTo(x + 30, i % 2 ? 40 : 190)
      x += 30
      ctx.lineTo(x, 40)
    }
    ctx.stroke()
    ctx.fillStyle = '#a38c55'
    ctx.fillRect(28, 216, 34, 34)
  }).texture
  return antennaTex
}

function espModule(g: THREE.Group, p: Part) {
  const body = bodyFor(p) // 18 x 25.5, antenna toward -Z
  const pcbT = 0.8
  b(g, body.w, pcbT, body.h, 0, pcbT / 2, 0, materials.moduleBoard, 0.15)
  // castellations: gold half-pads along the edges
  for (const pad of padsFor(p)) {
    const side = Math.abs(pad.x) > 8 ? 'x' : 'z'
    const w = side === 'x' ? 0.5 : 0.9
    const d = side === 'x' ? 0.9 : 0.5
    b(g, w, pcbT + 0.02, d, side === 'x' ? Math.sign(pad.x) * (body.w / 2 - 0.2) : pad.x, pcbT / 2, side === 'x' ? pad.y : body.h / 2 - 0.2, materials.gold, 0.02)
  }
  // RF shield can (towards the pin end)
  const canW = 15.8, canD = 17.6, canH = 2.3
  const canZ = body.h / 2 - canD / 2 - 0.8
  b(g, canW, canH, canD, 0, pcbT + canH / 2, canZ, materials.silver, 0.25)
  b(g, canW - 0.6, 0.05, canD - 0.6, 0, pcbT + canH + 0.005, canZ, materials.stamped, 0.02)
  marking(g, 'ESPRESSIF\nESP32-WROOM-32E', 11.5, 5.75, pcbT + canH + 0.04, '#43484c')
  const id = marking(g, 'FCC ID: 2AC7Z-ESPWROOM32E\nCE  ·  N8  ·  2547', 10.5, 5.25, pcbT + canH + 0.04, '#5a5f63')
  id.position.z = canZ + 4.6
  // antenna keep-out with meander trace
  topFace(g, body.w - 2, 5.2, pcbT + 0.01, moduleAntenna(), 'antenna').position.z = -body.h / 2 + 3.3
}

function passive(g: THREE.Group, p: Part) {
  const body = bodyFor(p)
  const isCap = p.ref.startsWith('C')
  const capW = body.w * 0.2
  b(g, body.w - capW * 2 + 0.02, body.height, body.h, 0, body.height / 2, 0, isCap ? materials.ceramic : materials.resistor, 0.05)
  for (const s of [-1, 1]) b(g, capW, body.height + 0.02, body.h + 0.02, s * (body.w / 2 - capW / 2), body.height / 2 + 0.01, 0, materials.tin, 0.06)
  if (!isCap && p.value) {
    const code = resistorCode(p.value)
    topFace(g, body.w * 0.55, body.h * 0.55, body.height + 0.006, createPassiveMarkingTexture(code), `pm:${code}`)
  }
}

function resistorCode(v: string) {
  const m = v.match(/([\d.]+)\s*([kKmM]?)/)
  if (!m) return v
  let ohms = parseFloat(m[1]) * (m[2] === 'k' || m[2] === 'K' ? 1e3 : m[2] === 'M' ? 1e6 : 1)
  if (ohms < 10) return m[1].replace('.', 'R')
  let exp = 0
  while (ohms >= 100) { ohms /= 10; exp++ }
  return `${Math.round(ohms)}${exp}`
}

function led(g: THREE.Group, p: Part) {
  const body = bodyFor(p)
  b(g, body.w, 0.25, body.h, 0, 0.125, 0, materials.ivory, 0.04)
  for (const s of [-1, 1]) b(g, 0.3, 0.27, body.h + 0.02, s * (body.w / 2 - 0.15), 0.135, 0, materials.tin, 0.04)
  const lens = b(g, body.w - 0.7, body.height - 0.25, body.h - 0.1, 0, 0.25 + (body.height - 0.25) / 2, 0, materials.ledLens, 0.08)
  lens.name = 'led-lens'
}

function ecap(g: THREE.Group, p: Part) {
  const body = bodyFor(p)
  const r = body.w / 2
  const h = body.height
  // rubber seal base, sleeve, crimp groove, top vent
  cyl(g, r - 0.15, 0.6, 0, 0.3, 0, materials.rubber)
  const sleeve = new THREE.MeshPhysicalMaterial({ color: 0x0f1012, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.2 })
  cyl(g, r, h - 1.2, 0, 0.6 + (h - 1.2) / 2, 0, sleeve, 64)
  cyl(g, r - 0.22, 0.35, 0, 1.6, 0, materials.silver, 64)
  cyl(g, r, 0.5, 0, h - 0.35, 0, sleeve, 64)
  cyl(g, r - 0.35, 0.12, 0, h - 0.04, 0, materials.silver, 64)
  // polarity band (white stripe on the negative side)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.01, r + 0.01, h - 1.4, 32, 1, true, Math.PI * 0.8, Math.PI * 0.4),
    new THREE.MeshStandardMaterial({ color: 0xd6d6d0, roughness: 0.5, side: THREE.DoubleSide }))
  band.position.y = 0.6 + (h - 1.2) / 2
  g.add(band)
  // K-vent stamped on top
  const vent = canvasTexture(256, 256, (c) => {
    c.strokeStyle = '#3a3d40'
    c.lineWidth = 9
    c.beginPath()
    c.moveTo(128, 40); c.lineTo(128, 216)
    c.moveTo(128, 128); c.lineTo(48, 70); c.moveTo(128, 128); c.lineTo(208, 70)
    c.stroke()
  }).texture
  topFace(g, (r - 0.4) * 2, (r - 0.4) * 2, h + 0.03, vent, 'kvent')
  // legs through the board
  for (const s of [-1, 1]) cyl(g, 0.3, 3.5, s * 1.75, -1.2, 0, materials.tin, 12)
}

function terminal(g: THREE.Group, p: Part) {
  const body = bodyFor(p) // w = n*5.08 along X, h = 7.6 along Z
  const n = p.pins ?? 2
  const H = body.height
  const mat = materials.plasticGrey
  // stepped housing: tall front (screws), lower back (wire entry)
  b(g, body.w, H * 0.72, body.h, 0, (H * 0.72) / 2, 0, mat, 0.3)
  b(g, body.w, H * 0.28, body.h * 0.55, 0, H * 0.72 + (H * 0.28) / 2, body.h * 0.2, mat, 0.25)
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * 5.08
    // screw well + slotted screw
    cyl(g, 1.55, 0.3, x, H + 0.02, body.h * 0.2, materials.rubber, 32)
    cyl(g, 1.3, 0.6, x, H - 0.1, body.h * 0.2, materials.silver, 32)
    b(g, 2.3, 0.2, 0.36, x, H + 0.22, body.h * 0.2, materials.rubber, 0.04).rotation.y = Math.PI / 4
    // wire entry opening on the outward face (local -Z) with a clamp visible
    b(g, 3.6, 3.3, 0.6, x, 3.1, -body.h / 2 + 0.25, materials.rubber, 0.2)
    b(g, 3.0, 0.4, 0.5, x, 2.0, -body.h / 2 + 0.2, materials.silver, 0.05)
    // separator ridges
    if (i < n - 1) b(g, 0.5, H * 0.72 + 0.4, body.h, x + 2.54, (H * 0.72 + 0.4) / 2, 0, mat, 0.12)
    cyl(g, 0.5, 3.4, x, -1.3, 0, materials.tin, 12)
  }
}

function header(g: THREE.Group, p: Part) {
  const body = bodyFor(p) // w = 2.54 (X), h = n*2.54 (Z)
  const n = p.pins ?? 6
  for (let i = 0; i < n; i++) {
    const z = (i - (n - 1) / 2) * 2.54
    b(g, 2.5, body.height, 2.48, 0, body.height / 2, z, materials.plastic, 0.12)
    b(g, 0.64, 11.4, 0.64, 0, 11.4 / 2 - 3, z, materials.gold, 0.06)
  }
}

function usbc(g: THREE.Group, p: Part) {
  const body = bodyFor(p) // 8.94 x 7.3 x 3.2, mouth toward +Z (board edge)
  const shell = b(g, body.w, body.height, body.h, 0, body.height / 2 + 0.05, 0, materials.silver, 1.2)
  shell.scale.z = 1
  // mouth: dark tongue cavity + tongue with gold contacts
  b(g, body.w - 0.7, body.height - 0.7, 0.3, 0, body.height / 2 + 0.05, body.h / 2 - 0.1, materials.rubber, 0.9)
  b(g, 6.2, 0.6, 0.35, 0, body.height / 2 + 0.05, body.h / 2 - 0.05, materials.plastic, 0.1)
  for (let i = 0; i < 12; i++) b(g, 0.25, 0.62, 0.36, -2.75 + i * 0.5, body.height / 2 + 0.05, body.h / 2 - 0.04, materials.gold, 0.01)
  // stamped seam & shell tabs
  b(g, body.w + 0.05, 0.05, 0.12, 0, body.height + 0.04, -body.h / 2 + 2.2, materials.stamped, 0.01)
  for (const s of [-1, 1]) {
    b(g, 0.3, 1.8, 1.4, s * (body.w / 2 + 0.05), 0.4, -1.5, materials.silver, 0.05)
    b(g, 0.3, 1.8, 1.4, s * (body.w / 2 + 0.05), 0.4, 1.9, materials.silver, 0.05)
  }
  // SMD signal legs at the back
  for (let i = 0; i < 12; i++) b(g, 0.25, 0.12, 0.9, -2.75 + i * 0.5, 0.06, -body.h / 2 - 0.35, materials.tin, 0.01)
}

function tact(g: THREE.Group, p: Part) {
  const body = bodyFor(p) // 6 x 6 x 3.4
  const deck = body.height - 1.3
  b(g, body.w, deck, body.h, 0, deck / 2, 0, materials.plastic, 0.1)
  stamped(g, body.w + 0.1, body.h + 0.1, 0.18, deck, [{ x: 0, z: 0, r: 1.9 }, ...[[-2.25, -2.25], [2.25, -2.25], [-2.25, 2.25], [2.25, 2.25]].map(([x, z]) => ({ x, z, r: 0.42 }))])
  cyl(g, 1.75, 1.3, 0, deck + 0.65, 0, materials.rubber, 48)
  cyl(g, 1.55, 0.06, 0, body.height + 0.01, 0, materials.plastic, 48)
  for (const [x, z] of [[-3.9, -2.25], [3.9, -2.25], [-3.9, 2.25], [3.9, 2.25]]) {
    b(g, 1.0, 0.18, 0.7, x * 0.88, 0.09, z, materials.stamped, 0.03)
    b(g, 0.18, deck * 0.8, 0.7, Math.sign(x) * (body.w / 2 + 0.05), deck * 0.4, z, materials.stamped, 0.03)
  }
}

let jointGeo: THREE.BufferGeometry | null = null
function thtJoints(g: THREE.Group, p: Part) {
  // conical solder joints on the underside of through-hole parts
  jointGeo ??= solderJointGeometry()
  for (const pad of padsFor(p)) {
    if (!pad.drill) continue
    const j = new THREE.Mesh(jointGeo, materials.solder)
    j.scale.setScalar(pad.drill * 1.15)
    j.position.set(pad.x, -1.6 - 0.02, pad.y)
    j.rotation.x = Math.PI
    g.add(j)
  }
}

/** Build a part model in its local frame. */
export function buildPart(p: Part): THREE.Group {
  const g = new THREE.Group()
  g.name = p.ref
  switch (p.kind) {
    case 'module': espModule(g, p); break
    case 'ssop':
    case 'soic': soicLike(g, p); break
    case 'sot223': sot223(g, p); break
    case 'chip': passive(g, p); break
    case 'led': led(g, p); break
    case 'ecap': ecap(g, p); break
    case 'terminal': terminal(g, p); break
    case 'header': header(g, p); break
    case 'usbc': usbc(g, p); break
    case 'tact': tact(g, p); break
  }
  thtJoints(g, p)
  g.traverse((o) => {
    o.userData.ref = p.ref
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true
      o.receiveShadow = true
    }
  })
  return g
}

/** Pick-proxy size per part (for hover/outline). */
export function partHeight(p: Part) {
  return p.kind === 'header' ? 8.4 : bodyFor(p).height
}
