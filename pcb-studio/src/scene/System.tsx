// System scale: the custom PCB mounted on a rover chassis together with every
// off-board device it drives. Scroll in (or click the PCB) to dive into the
// board; the board view hands the camera back when you scroll out.
import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { CameraControls, Html } from '@react-three/drei'
import { byId } from '@/data/catalog'
import type { Board } from '@/data/board'
import type { Bus, SystemDesign, SystemDevice } from '@/data/system'
import { routeNets } from '@/pcb/footprint'
import { getStudio, setStudio, useStudio } from '@/state/studio'
import { buildDevice } from './devices'
import { partHeight } from './packages'
import { BoardMesh, ExportBridge, Parts } from './Scene'
import { handoff, takeHandoff } from './handoff'

export const BUS_COLOR: Record<Bus, string> = {
  power: '#d9564f',
  motor: '#d6a23a',
  i2c: '#5b8def',
  gpio: '#9aa4b2',
  data: '#e2e6ec',
}

const anodized = new THREE.MeshPhysicalMaterial({ color: 0x24272b, roughness: 0.42, metalness: 0.75, clearcoat: 0.2 })
const holeMat = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.9 })
const brass = new THREE.MeshStandardMaterial({ color: 0xb89b5e, roughness: 0.32, metalness: 1 })
const ISO_DIR = new THREE.Vector3(0.76, 0.56, 0.88).normalize()

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

/** Where a device sits when assembled and how far it travels when exploded. */
function mount(sys: SystemDesign, d: SystemDevice) {
  const item = byId[d.catalogId]
  const base = new THREE.Vector3(d.x, d.y + (d.stand ? item.dimensions.h / 2 : 0), d.z)
  const out = new THREE.Vector3(d.x, 0, d.z).normalize().multiplyScalar(d.bus === 'motor' ? 26 : 18)
  const lift = d.bus === 'motor' ? -6 : 34 + Math.abs(d.z) * 0.08
  return { base, explode: new THREE.Vector3(out.x, lift, out.z), size: Math.max(item.dimensions.w, item.dimensions.h), sys }
}

/** Cable end point on a device, in the device's local frame. */
function anchorLocal(d: SystemDevice) {
  const item = byId[d.catalogId]
  const { w, h } = item.dimensions
  if (d.bus === 'motor') return new THREE.Vector3(w * 0.42, h * 0.75, 0)
  if (d.stand) return new THREE.Vector3(0, 2, -h / 2 + 1.6)
  return new THREE.Vector3(0, 2.2, -h / 2 + 1.6)
}

const Chassis = memo(function Chassis({ sys }: { sys: SystemDesign }) {
  const { w, d, t } = sys.chassis
  const plate = useMemo(() => {
    const r = 10
    const s = new THREE.Shape()
    s.moveTo(-w / 2 + r, -d / 2)
    s.lineTo(w / 2 - r, -d / 2)
    s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r)
    s.lineTo(w / 2, d / 2 - r)
    s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2)
    s.lineTo(-w / 2 + r, d / 2)
    s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r)
    s.lineTo(-w / 2, -d / 2 + r)
    s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2)
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const cz = -d / 2 + 52 + i * ((d - 104) / 3)
        const hole = new THREE.Path()
        hole.absarc(sx * (w / 2 - 14), cz, 4.2, 0, Math.PI * 2, true)
        s.holes.push(hole)
      }
    }
    const g = new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: true, bevelSize: 0.6, bevelThickness: 0.6, bevelSegments: 3, curveSegments: 24 })
    g.rotateX(Math.PI / 2)
    return g
  }, [w, d, t])

  const grid = useMemo(() => {
    const pts: [number, number][] = []
    for (let x = -w / 2 + 26; x <= w / 2 - 26; x += 10) {
      for (let z = -d / 2 + 14; z <= d / 2 - 14; z += 10) {
        if (Math.abs(x) < 46 && Math.abs(z) < 36) continue
        if (Math.abs(z) > 48 && Math.abs(z) < 108 && Math.abs(x) > 18) continue
        pts.push([x, z])
      }
    }
    return pts
  }, [w, d])

  const inst = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const m = inst.current
    if (!m) return
    const o = new THREE.Object3D()
    grid.forEach(([x, z], i) => {
      o.position.set(x, 0.62, z)
      o.updateMatrix()
      m.setMatrixAt(i, o.matrix)
    })
    m.instanceMatrix.needsUpdate = true
  }, [grid])

  return (
    <group>
      <mesh geometry={plate} material={anodized} castShadow receiveShadow />
      <instancedMesh ref={inst} args={[undefined, undefined, grid.length]} material={holeMat} receiveShadow>
        <cylinderGeometry args={[1.6, 1.6, 0.1, 16]} />
      </instancedMesh>
    </group>
  )
})

function Standoffs({ board, height }: { board: Board; height: number }) {
  return (
    <>
      {board.holes.map((h, i) => (
        <group key={i} position={[h.x, 0, h.y]}>
          <mesh material={brass} position-y={height / 2} castShadow>
            <cylinderGeometry args={[2.6, 2.6, height, 6]} />
          </mesh>
          <mesh material={brass} position-y={height + board.thickness + 1}>
            <cylinderGeometry args={[2.8, 2.8, 2, 18]} />
          </mesh>
        </group>
      ))}
    </>
  )
}

const Pcb = memo(function Pcb({ sys }: { sys: SystemDesign }) {
  const board = useStudio((s) => s.board)
  const traces = useMemo(() => routeNets(board), [board])
  const exploded = useStudio((s) => s.exploded)
  const hover = useStudio((s) => s.hoveredDevice === 'pcb')
  const selected = useStudio((s) => s.device === 'pcb')
  const labelMode = useStudio((s) => s.labelMode)
  const g = useRef<THREE.Group>(null)
  const ring = useRef<THREE.Mesh>(null)
  const anim = useRef({ since: 0, from: 0, to: 0 })

  useEffect(() => {
    anim.current = { since: performance.now(), from: anim.current.to, to: exploded ? 1 : 0 }
  }, [exploded])

  useFrame((_, dt) => {
    const { since, from, to } = anim.current
    const t = Math.min(1, (performance.now() - since) / 750)
    const e = from + (to - from) * easeOut(t)
    if (g.current) g.current.position.y = sys.pcbHeight + e * 22
    if (ring.current) {
      const m = ring.current.material as THREE.MeshBasicMaterial
      m.opacity = THREE.MathUtils.damp(m.opacity, selected ? 0.85 : hover ? 0.55 : 0, 10, dt)
    }
  })

  const showLabel = labelMode === 'all' || (labelMode === 'contextual' && (selected || hover))
  const W = board.width + 6
  const H = board.height + 6

  return (
    <>
      <Standoffs board={board} height={sys.pcbHeight} />
      <group
        ref={g}
        position-y={sys.pcbHeight}
        name="system-pcb"
        onPointerOver={(e) => {
          e.stopPropagation()
          setStudio({ hoveredDevice: 'pcb' })
          document.body.style.cursor = 'zoom-in'
        }}
        onPointerOut={() => {
          setStudio({ hoveredDevice: null })
          document.body.style.cursor = ''
        }}
        onClick={(e) => {
          e.stopPropagation()
          if (e.delta > 4) return
          if (getStudio().device === 'pcb') window.dispatchEvent(new Event('forge:dive'))
          else setStudio({ device: 'pcb', touring: false })
        }}
      >
        <BoardMesh board={board} traces={traces} />
        <Parts board={board} passive />
        <mesh ref={ring} rotation-x={-Math.PI / 2} position-y={-0.3} userData={{ noExport: true }}>
          <ringGeometry args={[Math.hypot(W, H) / 2 - 1.2, Math.hypot(W, H) / 2 + 0.4, 72]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} depthWrite={false} />
        </mesh>
        {showLabel && (
          <Html position={[0, 18, 0]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div className={`forge-tag ${selected ? 'is-active' : ''}`}>
              <span>{board.name}</span>
              <span className="forge-tag-sub">Click again to open</span>
            </div>
          </Html>
        )}
      </group>
    </>
  )
})

const Device = memo(function Device({
  d,
  index,
  sys,
  onReady,
}: {
  d: SystemDevice
  index: number
  sys: SystemDesign
  onReady: (id: string, g: THREE.Group | null) => void
}) {
  const item = byId[d.catalogId]
  const model = useMemo(() => buildDevice(item), [item])
  const exploded = useStudio((s) => s.exploded)
  const selected = useStudio((s) => s.device === d.id)
  const hovered = useStudio((s) => s.hoveredDevice === d.id)
  const labelMode = useStudio((s) => s.labelMode)
  const g = useRef<THREE.Group>(null)
  const haloRef = useRef<THREE.Mesh>(null)
  const anim = useRef({ since: 0, from: 0, to: 0 })
  const lift = useRef(0)
  const m = useMemo(() => mount(sys, d), [sys, d])

  const { wheels, ringRadius } = useMemo(() => {
    const wList: THREE.Object3D[] = []
    model.traverse((o) => {
      if (o.name === 'wheel') wList.push(o)
    })
    const bx = new THREE.Box3().setFromObject(model)
    const sz = bx.getSize(new THREE.Vector3())
    return { wheels: wList, ringRadius: Math.max(14, Math.hypot(sz.x, sz.z) * 0.48) }
  }, [model])

  useEffect(() => {
    model.traverse((o) => {
      o.userData.device = d.id
    })
  }, [model, d.id])

  useEffect(() => {
    anim.current = { since: performance.now(), from: anim.current.to, to: exploded ? 1 : 0 }
  }, [exploded])

  useFrame((_, dt) => {
    const grp = g.current
    if (!grp) return
    const { since, from, to } = anim.current
    const delay = index * 0.04
    const t = Math.min(1, Math.max(0, ((performance.now() - since) / 1000 - delay) / 0.75))
    const e = from + (to - from) * easeOut(t)
    const targetLift = selected ? 3.5 : hovered ? 2.2 : 0
    lift.current = THREE.MathUtils.damp(lift.current, targetLift, 11, dt)
    grp.position.set(
      m.base.x + m.explode.x * e,
      m.base.y + m.explode.y * e + lift.current,
      m.base.z + m.explode.z * e,
    )
    if (getStudio().touring && wheels.length) {
      for (const w of wheels) w.rotation.x -= dt * 2.0 * (d.rot === 180 ? -1 : 1)
    }
    if (haloRef.current) {
      const mat = haloRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = THREE.MathUtils.damp(mat.opacity, selected ? 0.85 : hovered ? 0.42 : 0, 12, dt)
    }
  })

  const tagHeight = Math.max(item.dimensions.thickness, (model.userData.height as number) ?? 10)
  const showLabel = labelMode === 'all' || (labelMode === 'contextual' && (selected || hovered))
  const highlightColor = selected ? '#f5f6f8' : BUS_COLOR[d.bus]

  return (
    <group
      ref={(r) => {
        g.current = r
        onReady(d.id, r)
      }}
      position={m.base.toArray()}
      rotation={[d.stand ? -Math.PI / 2 : 0, (d.rot * Math.PI) / 180, 0, 'YXZ']}
      onPointerOver={(e) => {
        e.stopPropagation()
        if (getStudio().hoveredDevice !== d.id) setStudio({ hoveredDevice: d.id })
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        setStudio({ hoveredDevice: null })
        document.body.style.cursor = ''
      }}
      onClick={(e) => {
        e.stopPropagation()
        if (e.delta > 4) return
        setStudio({ device: d.id, touring: false })
      }}
    >
      <primitive object={model} />
      <mesh
        ref={haloRef}
        rotation-x={d.stand ? 0 : -Math.PI / 2}
        position={d.stand ? [0, 0, 1] : [0, 0.4, 0]}
        userData={{ noExport: true }}
      >
        <ringGeometry args={[ringRadius - 1.3, ringRadius, 48]} />
        <meshBasicMaterial color={highlightColor} transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      {showLabel && (
        <Html
          position={
            d.stand
              ? [0, 5, item.dimensions.h / 2 + 12]
              : [d.bus === 'motor' ? -item.dimensions.w * 0.25 : 0, tagHeight + 10, 0]
          }
          center
          zIndexRange={[20, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className={`forge-tag ${selected ? 'is-active' : ''}`}>
            <span>{d.label}</span>
            <span className="forge-tag-sub">{item.name}</span>
          </div>
        </Html>
      )}
    </group>
  )
})

/** Bus cables from the PCB connectors to each device, dimmed when unrelated. */
const Cables = memo(function Cables({
  sys,
  groups,
  pcb,
}: {
  sys: SystemDesign
  groups: React.RefObject<Map<string, THREE.Group>>
  pcb: () => THREE.Object3D | null
}) {
  const board = useStudio((s) => s.board)
  const hoveredDevice = useStudio((s) => s.hoveredDevice)
  const selected = useStudio((s) => s.device)
  const showAllWires = useStudio((s) => s.showAllWires)
  const meshes = useRef<(THREE.Mesh | null)[]>([])

  const ports = useMemo(() => {
    const portCount = new Map<string, number>()
    return sys.devices.map((d) => {
      const p = board.parts.find((q) => q.ref === d.port)
      const k = portCount.get(d.port) ?? 0
      portCount.set(d.port, k + 1)
      return { part: p, k }
    })
  }, [sys, board])

  const tmp = useMemo(() => new THREE.Vector3(), [])

  useFrame(() => {
    const top = pcb()
    const pcbY = top ? top.position.y : sys.pcbHeight
    sys.devices.forEach((d, i) => {
      const mesh = meshes.current[i]
      const grp = groups.current?.get(d.id)
      if (!mesh || !grp) return
      const { part, k } = ports[i]
      const px = part ? part.x + (k - 1.5) * 1.4 : 0
      const pz = part ? part.y : 0
      const start = new THREE.Vector3(px, pcbY + board.thickness + (part ? partHeight(part) * 0.7 : 4), pz)
      grp.updateMatrixWorld()
      const end = tmp.copy(anchorLocal(d)).applyMatrix4(grp.matrixWorld).clone()
      const key = `${start.x.toFixed(1)},${start.y.toFixed(1)},${end.x.toFixed(1)},${end.y.toFixed(1)},${end.z.toFixed(1)}`
      if (mesh.userData.key === key) return
      mesh.userData.key = key
      const mid = start.clone().lerp(end, 0.5)
      mid.y = Math.max(start.y, end.y) + 9 + start.distanceTo(end) * 0.07
      const curve = new THREE.CatmullRomCurve3(
        [
          start,
          start.clone().add(new THREE.Vector3(0, 5, 0)),
          mid,
          end.clone().add(new THREE.Vector3(0, d.bus === 'motor' ? 2 : 6, 0)),
          end,
        ],
        false,
        'centripetal',
      )
      mesh.geometry.dispose()
      mesh.geometry = new THREE.TubeGeometry(curve, 28, d.bus === 'power' || d.bus === 'motor' ? 0.8 : 0.55, 6, false)
    })
  })

  const focusId = hoveredDevice ?? (selected && selected !== 'pcb' ? selected : null)

  return (
    <>
      {sys.devices.map((d, i) => {
        const isFocused = focusId === d.id
        const isPcbSelected = selected === 'pcb' || hoveredDevice === 'pcb'
        const opacity = showAllWires
          ? isFocused
            ? 1
            : 0.88
          : isFocused
          ? 1
          : isPcbSelected
          ? 0.55
          : focusId
          ? 0.08
          : 0.28
        return (
          <mesh
            key={d.id}
            ref={(m) => {
              meshes.current[i] = m
            }}
            castShadow={opacity > 0.4}
            userData={{ noExport: false }}
          >
            <bufferGeometry />
            <meshStandardMaterial
              color={BUS_COLOR[d.bus]}
              roughness={0.5}
              transparent
              opacity={opacity}
              depthWrite={opacity > 0.5}
              emissive={BUS_COLOR[d.bus]}
              emissiveIntensity={isFocused ? 0.55 : 0.03}
            />
          </mesh>
        )
      })}
    </>
  )
})

function computeAutoFitPose(
  rootObj: THREE.Object3D | null,
  camera: THREE.Camera,
  paddingFactor = 1.24,
): { pos: THREE.Vector3; target: THREE.Vector3; distance: number } {
  const box = new THREE.Box3()
  if (rootObj) {
    rootObj.updateMatrixWorld(true)
    box.setFromObject(rootObj)
  }
  if (box.isEmpty()) {
    box.setFromCenterAndSize(new THREE.Vector3(0, -6, 0), new THREE.Vector3(220, 90, 240))
  }
  const sphere = box.getBoundingSphere(new THREE.Sphere())
  const persp = camera as THREE.PerspectiveCamera
  const vFov = THREE.MathUtils.degToRad(persp.fov || 32)
  const aspect = Math.max(0.65, persp.aspect || 1.35)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)
  const limitingFov = Math.min(vFov, hFov)
  const radius = Math.max(125, sphere.radius)
  const distance = (radius / Math.sin(limitingFov / 2)) * paddingFactor
  const target = new THREE.Vector3(sphere.center.x, sphere.center.y - 4, sphere.center.z)
  const pos = target.clone().addScaledVector(ISO_DIR, distance)
  return { pos, target, distance }
}

function SystemCamera({
  sys,
  groups,
  root,
}: {
  sys: SystemDesign
  groups: React.RefObject<Map<string, THREE.Group>>
  root: React.RefObject<THREE.Group | null>
}) {
  const controls = useRef<CameraControls>(null)
  const gl = useThree((t) => t.gl)
  const camera = useThree((t) => t.camera)
  const device = useStudio((s) => s.device)
  const fitNonce = useStudio((s) => s.fitNonce)
  const view = useStudio((s) => s.view)
  const touring = useStudio((s) => s.touring)
  const intro = useRef(true)
  const diving = useRef(false)
  const pcbCentre = useMemo(() => new THREE.Vector3(0, sys.pcbHeight, 0), [sys.pcbHeight])
  const lastView = useRef(view)

  // Initial aspect-aware framing: fits the entire rover cleanly with breathing room
  useEffect(() => {
    const c = controls.current
    if (!c) return
    c.smoothTime = 0.42
    c.draggingSmoothTime = 0.12
    c.minDistance = 40
    c.maxDistance = 1400

    const fit = computeAutoFitPose(root.current, camera, 1.24)
    const h = takeHandoff()
    if (h) {
      const p = h.pos.add(pcbCentre)
      const t = h.target.add(pcbCentre)
      c.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false)
      const id = setTimeout(() => {
        c.smoothTime = 0.75
        c.setLookAt(fit.pos.x, fit.pos.y, fit.pos.z, fit.target.x, fit.target.y, fit.target.z, true).then(() => {
          c.smoothTime = 0.42
          intro.current = false
        })
      }, 40)
      return () => clearTimeout(id)
    }

    // Place cleanly right away at an attractive isometric angle so initial render is immediately framed
    c.setLookAt(fit.pos.x, fit.pos.y, fit.pos.z, fit.target.x, fit.target.y, fit.target.z, false)
    intro.current = false
  }, [camera, pcbCentre, root])

  // Dive into the PCB board view
  useEffect(() => {
    const dive = async () => {
      const c = controls.current
      if (!c || diving.current) return
      diving.current = true
      setStudio({ touring: false, exploded: false })
      c.smoothTime = 0.5
      const pos = new THREE.Vector3()
      c.getPosition(pos)
      const dir = pos.sub(pcbCentre).normalize()
      if (dir.y < 0.35) dir.setY(0.6).normalize()
      const near = pcbCentre.clone().addScaledVector(dir, 120)
      await c.setLookAt(near.x, near.y, near.z, 0, sys.pcbHeight, 0, true)
      handoff.pos = near.clone().sub(pcbCentre)
      handoff.target = new THREE.Vector3(0, 0, 0)
      window.dispatchEvent(new CustomEvent('forge:scale', { detail: 'board' }))
    }
    window.addEventListener('forge:dive', dive)
    return () => window.removeEventListener('forge:dive', dive)
  }, [pcbCentre, sys.pcbHeight])

  // Scroll-in threshold → dive into board
  useEffect(() => {
    const c = controls.current
    if (!c) return
    const onUpdate = () => {
      if (intro.current || diving.current) return
      const t = new THREE.Vector3()
      c.getTarget(t)
      if (c.distance < 95 && t.distanceTo(pcbCentre) < 60) window.dispatchEvent(new Event('forge:dive'))
    }
    c.addEventListener('update', onUpdate)
    return () => c.removeEventListener('update', onUpdate)
  }, [pcbCentre])

  // Gentle selection nudge: shift focus softly toward selected part without cropping the rover
  useEffect(() => {
    const c = controls.current
    if (!c || intro.current || !device || getStudio().touring) return
    const grp = device === 'pcb' ? null : groups.current?.get(device)
    const box = new THREE.Box3()
    if (grp) box.setFromObject(grp)
    else box.setFromCenterAndSize(pcbCentre, new THREE.Vector3(90, 20, 70))
    const partCenter = box.getCenter(new THREE.Vector3())
    const blendedTarget = new THREE.Vector3(0, -4, 0).lerp(partCenter, 0.42)
    c.moveTo(blendedTarget.x, blendedTarget.y, blendedTarget.z, true)
  }, [device, groups, pcbCentre])

  // Explicit camera Fit button
  useEffect(() => {
    const c = controls.current
    if (!c || !fitNonce) return
    const fit = computeAutoFitPose(root.current, camera, 1.24)
    c.setLookAt(fit.pos.x, fit.pos.y, fit.pos.z, fit.target.x, fit.target.y, fit.target.z, true)
  }, [fitNonce, root, camera])

  // View preset switch (3D / Top / Bottom)
  useEffect(() => {
    const c = controls.current
    if (!c || intro.current || lastView.current === view) return
    lastView.current = view
    setStudio({ touring: false })
    const fit = computeAutoFitPose(root.current, camera, 1.24)
    if (view === 'top') c.setLookAt(0, fit.distance * 1.05, 0.01, 0, 0, 0, true)
    else if (view === 'bottom') c.setLookAt(0, -fit.distance * 1.05, 0.01, 0, 0, 0, true)
    else c.setLookAt(fit.pos.x, fit.pos.y, fit.pos.z, fit.target.x, fit.target.y, fit.target.z, true)
  }, [view, root, camera])

  // Opt-in showcase tour
  useEffect(() => {
    const c = controls.current
    if (!c || !touring) return
    let alive = true
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const run = async () => {
      while (intro.current && alive) await wait(100)
      const fit = computeAutoFitPose(root.current, camera, 1.24)
      let lap = 0
      while (alive) {
        c.smoothTime = 1.1
        setStudio({ exploded: true, device: null })
        await c.setLookAt(-fit.pos.x * (lap % 2 ? -1 : 1), fit.pos.y, fit.pos.z, 0, 6, 0, true)
        await wait(1200)
        for (let i = 0; i < sys.devices.length && alive; i++) {
          const d = sys.devices[i]
          const grp = groups.current?.get(d.id)
          if (!grp) continue
          const box = new THREE.Box3().setFromObject(grp)
          const centre = box.getCenter(new THREE.Vector3())
          const a = Math.atan2(d.z, d.x) + 0.55
          const dist = Math.max(180, box.getSize(new THREE.Vector3()).length() * 2.5)
          setStudio({ device: d.id })
          c.smoothTime = 0.85
          await c.setLookAt(
            centre.x + Math.cos(a) * dist,
            centre.y + dist * 0.62,
            centre.z + Math.sin(a) * dist,
            centre.x,
            centre.y,
            centre.z,
            true,
          )
          if (!alive) return
          c.smoothTime = 2.0
          c.rotate(0.25, 0, true)
          await wait(1300)
        }
        if (!alive) return
        c.smoothTime = 1.1
        setStudio({ exploded: false, device: null })
        await c.setLookAt(fit.pos.x, fit.pos.y, fit.pos.z, fit.target.x, fit.target.y, fit.target.z, true)
        await wait(2400)
        lap++
      }
    }
    run()
    const stop = () => setStudio({ touring: false })
    const el = gl.domElement
    el.addEventListener('pointerdown', stop)
    el.addEventListener('wheel', stop, { passive: true })
    return () => {
      alive = false
      c.smoothTime = 0.42
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('wheel', stop)
    }
  }, [touring, sys, groups, gl, root, camera])

  return <CameraControls ref={controls} makeDefault />
}

export function SystemRoot() {
  const sys = useStudio((s) => s.system)
  const root = useRef<THREE.Group>(null)
  const groups = useRef(new Map<string, THREE.Group>())
  const pcbRef = useCallback(() => root.current?.getObjectByName('system-pcb') ?? null, [])
  const onReady = useCallback((id: string, g: THREE.Group | null) => {
    if (g) groups.current.set(id, g)
    else groups.current.delete(id)
  }, [])
  return (
    <>
      <group name="pcb-root" ref={root} onPointerMissed={() => setStudio({ device: null })}>
        <Chassis sys={sys} />
        <Pcb sys={sys} />
        {sys.devices.map((d, i) => (
          <Device key={d.id + d.catalogId} d={d} index={i} sys={sys} onReady={onReady} />
        ))}
        <Cables sys={sys} groups={groups} pcb={pcbRef} />
      </group>
      <SystemCamera sys={sys} groups={groups} root={root} />
      <ExportBridge root={root} />
    </>
  )
}
