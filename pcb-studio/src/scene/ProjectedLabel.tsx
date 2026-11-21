import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export const LabelOverlay = createContext<React.RefObject<HTMLDivElement | null> | null>(null)

/** DOM-only labels: no secondary React roots to unmount during scene transitions. */
export function ProjectedLabel({ position, title, subtitle, active = false }: {
  position: [number, number, number]
  title: string
  subtitle?: string
  active?: boolean
}) {
  const overlay = useContext(LabelOverlay)
  const anchor = useRef<THREE.Group>(null)
  const node = useRef<HTMLDivElement | null>(null)
  const point = useMemo(() => new THREE.Vector3(), [])
  useEffect(() => {
    const host = overlay?.current
    if (!host) return
    const label = document.createElement('div')
    label.className = `forge-tag ${active ? 'is-active' : ''}`
    label.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden'
    const name = document.createElement('span')
    name.textContent = title
    label.append(name)
    if (subtitle) {
      const sub = document.createElement('span')
      sub.className = 'forge-tag-sub'
      sub.textContent = subtitle
      label.append(sub)
    }
    host.append(label)
    node.current = label
    return () => { label.remove(); node.current = null }
  }, [overlay, title, subtitle, active])
  useFrame(({ camera, size }) => {
    if (!anchor.current || !node.current) return
    anchor.current.getWorldPosition(point).project(camera)
    node.current.style.visibility = Math.abs(point.z) <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 ? 'visible' : 'hidden'
    node.current.style.transform = `translate(${(point.x + 1) * size.width / 2}px, ${(1 - point.y) * size.height / 2}px) translate(-50%, -50%)`
  })
  return <group ref={anchor} position={position} userData={{ noExport: true }} />
}
