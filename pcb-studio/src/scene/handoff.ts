// Camera pose carried across the system ↔ board scale switch so the zoom feels
// continuous. Coordinates are relative to the custom PCB's centre.
import * as THREE from 'three'

export const handoff: { pos: THREE.Vector3 | null; target: THREE.Vector3 | null } = { pos: null, target: null }

export function takeHandoff() {
  const h = handoff.pos && handoff.target ? { pos: handoff.pos.clone(), target: handoff.target.clone() } : null
  handoff.pos = null
  handoff.target = null
  return h
}
