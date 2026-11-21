import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from 'react'
import * as THREE from 'three'
import { STLExporter } from 'three/addons/exporters/STLExporter.js'
import { useStudio } from '@/state/studio'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Center, OrbitControls, useGLTF } from '@react-three/drei'

function Model({ url }: { url: string }) {
  const { scene, animations } = useGLTF(url)
  const req = useStudio((s) => s.exportRequest)
  const seen = useRef(req?.nonce ?? 0) // ignore requests made before this model was shown
  // Models come in arbitrary units: scale the longest side to a fixed size so every one fills the view.
  // Every mesh is one piece: it flies in from outside along its own direction, bottom pieces first.
  const rig = useMemo(() => {
    const meshes: THREE.Mesh[] = []
    scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh) })
    for (const m of meshes) { if (m.userData.home) m.position.copy(m.userData.home); else m.userData.home = m.position.clone() }
    scene.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(scene)
    const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3())
    const reach = Math.max(size.x, size.y, size.z) * 0.55
    const pieces = meshes.map((mesh) => {
      const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3())
      const dir = c.clone().sub(mid)
      if (dir.length() < reach * 0.05) dir.set(0, 1, 0)
      dir.normalize().multiplyScalar(reach)
      // world offset -> the mesh parent's local space
      const inv = new THREE.Matrix3().setFromMatrix4(mesh.parent!.matrixWorld).invert()
      return { mesh, home: mesh.userData.home as THREE.Vector3, off: dir.applyMatrix3(inv), y: c.y }
    }).sort((a, b) => a.y - b.y)
    return { size, pieces }
  }, [scene])
  useEffect(() => {
    if (!req || req.nonce === seen.current) return
    seen.current = req.nonce
    const name = url.split('/').pop()!.replace(/\.glb$/, '')
    const a = document.createElement('a')
    if (req.format === 'stl') {
      for (const p of rig.pieces) p.mesh.position.copy(p.home) // export assembled, not mid-animation
      scene.updateWorldMatrix(true, true)
      const data = new STLExporter().parse(scene, { binary: true }) as DataView
      a.href = URL.createObjectURL(new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' }))
      a.download = `${name}.stl`
    } else if (req.format === 'glb') {
      a.href = url
      a.download = `${name}.glb`
    } else return
    a.click()
    if (a.href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [req, scene, url, rig])
  const { size } = rig
  const k = 3.2 / (Math.max(size.x, size.y, size.z) || 1)
  const mixer = useMemo(() => {
    if (!animations.length) return null
    const m = new THREE.AnimationMixer(scene)
    for (const clip of animations) m.clipAction(clip).play()
    return m
  }, [scene, animations])
  const gl = useThree((s) => s.gl)
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, -1, 0), 3), [])
  const solo = rig.pieces.length < 2 // one fused mesh: build it up bottom to top instead
  useEffect(() => {
    gl.localClippingEnabled = true
    const mats = rig.pieces.flatMap((p) => (Array.isArray(p.mesh.material) ? p.mesh.material : [p.mesh.material]))
    for (const m of mats) { m.clippingPlanes = solo ? [plane] : null; m.needsUpdate = true }
    return () => { for (const m of mats) { m.clippingPlanes = null; m.needsUpdate = true } }
  }, [gl, rig, plane, solo])
  const t0 = useRef<number | null>(null)
  useFrame(({ clock }, dt) => {
    mixer?.update(dt)
    t0.current ??= clock.elapsedTime
    const u = (clock.elapsedTime - t0.current) % 10 // assemble 0-3.5s, hold, come apart from 7s
    const ease = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c) }
    const n = rig.pieces.length
    if (solo) {
      const h = size.y * k * 0.5 + 0.1
      plane.constant = -h + 2 * h * (u < 7 ? ease(u / 3) : 1 - ease((u - 7) / 2.5))
      return
    }
    if (mixer) return // authored animation owns the transforms
    rig.pieces.forEach((p, i) => {
      const d = (i / n) * 2.4
      const out = u < 7 ? 1 - ease((u - d) / 1.1) : ease((u - 7 - d * 0.6) / 1.1)
      p.mesh.position.copy(p.home).addScaledVector(p.off, out)
    })
  })
  return <Center key={url}><primitive object={scene} scale={k} /></Center>
}
class ViewerError extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <div className="p-8 text-sm text-red-300">Could not display this model.</div> : this.props.children }
}
/** Shows a bundled whole-object model from public/concepts. */
export function ConceptScene({ url }: { url: string }) {
  return <ViewerError key={url}><Canvas camera={{ position: [4, 3, 5], fov: 40 }} dpr={1}><color attach="background" args={['#0c0d0f']} /><ambientLight intensity={1.4} /><directionalLight position={[5, 8, 5]} intensity={3} /><directionalLight position={[-4, 2, -3]} intensity={1.2} /><Suspense fallback={null}><Model url={url}/></Suspense><OrbitControls makeDefault autoRotate autoRotateSpeed={0.7} /></Canvas></ViewerError>
}
