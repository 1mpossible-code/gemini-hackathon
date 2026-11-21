// In-browser exports: STL / GLB / OBJ / PNG / BOM JSON. No server, no Blender.
import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'
import type { ExportFormat } from '@/state/studio'
import { getStudio } from '@/state/studio'
import { routeNets, traceLength } from '@/pcb/footprint'

function download(data: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Clone the board without helpers/decals, baked to world space in millimetres (Z-up for CAD). */
function exportable(root: THREE.Object3D, forPrint: boolean) {
  const out = new THREE.Group()
  root.updateWorldMatrix(true, true)
  root.traverse((o) => {
    if (o.userData.noExport) return
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.visible) return
    const mat = Array.isArray(m.material) ? m.material[0] : m.material
    if (forPrint && (mat as THREE.Material).transparent) return // drop decals/lenses for STL
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld)
    const clone = new THREE.Mesh(g, m.material)
    clone.name = (o.userData.ref as string) ?? o.name
    out.add(clone)
  })
  if (forPrint) out.rotation.x = Math.PI / 2 // Y-up scene → Z-up CAD
  out.updateMatrixWorld(true)
  return out
}

function slug() {
  const b = getStudio().board
  return `${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-rev-${b.revision.toLowerCase()}`
}

export function bom() {
  const b = getStudio().board
  const traces = routeNets(b)
  const lines = new Map<string, { mpn: string; manufacturer: string; refs: string[]; pkg: string; unit: number }>()
  for (const p of b.parts) {
    const key = p.mpn + (p.value ?? '')
    const l = lines.get(key) ?? { mpn: p.mpn, manufacturer: p.manufacturer, refs: [], pkg: p.pkg, unit: p.pricing?.[0]?.price ?? 0 }
    l.refs.push(p.ref)
    lines.set(key, l)
  }
  return {
    board: { name: b.name, revision: b.revision, widthMm: b.width, heightMm: b.height, thicknessMm: b.thickness },
    bom: [...lines.values()].map((l) => ({ ...l, qty: l.refs.length, extended: +(l.unit * l.refs.length).toFixed(4) })),
    nets: b.nets.map((n) => n.name),
    traceLengthMm: +traces.reduce((s, t) => s + traceLength(t), 0).toFixed(2),
    verification: getStudio().verification,
  }
}

export async function exportScene(format: ExportFormat, root: THREE.Object3D, gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
  const name = slug()
  if (format === 'png') {
    gl.render(scene, camera)
    const url = gl.domElement.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.png`
    a.click()
    return
  }
  if (format === 'json') {
    download(JSON.stringify(bom(), null, 2), `${name}-bom.json`, 'application/json')
    return
  }
  if (format === 'stl') {
    const data = new STLExporter().parse(exportable(root, true), { binary: true }) as DataView
    download(data.buffer as ArrayBuffer, `${name}.stl`, 'model/stl')
    return
  }
  if (format === 'obj') {
    download(new OBJExporter().parse(exportable(root, true)), `${name}.obj`, 'text/plain')
    return
  }
  if (format === 'glb') {
    const glb = await new GLTFExporter().parseAsync(exportable(root, false), { binary: true, onlyVisible: true })
    download(glb as ArrayBuffer, `${name}.glb`, 'model/gltf-binary')
  }
}
