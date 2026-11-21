// System-scale assembly: the custom PCB plus the off-board devices it drives.
// Coordinates in mm, world X right, Z toward the viewer (rover front is -Z).
import type { Board } from './board'
import { checkHardware } from './hardwareAnalysis'
import { byId, catalog, type CatalogItem } from './catalog'

export type Bus = 'power' | 'motor' | 'i2c' | 'gpio' | 'data'
export type CheckSeverity = 'ok' | 'warning' | 'unverified'

export interface SystemDevice {
  id: string
  catalogId: string
  label: string
  role: string
  bus: Bus
  /** Board connector this device plugs into, e.g. "J7". */
  port: string
  x: number
  z: number
  /** Height of the device's mount above the chassis top. Negative hangs below. */
  y: number
  rot: number // degrees about Y
  /** Stand the device up on its edge (sonar facing forward). */
  stand?: boolean
  /** Nominal supply rail feeding this device or its driver stage, in volts. */
  rail: number
}

export interface SystemDesign {
  name: string
  chassis: { w: number; d: number; t: number }
  pcbHeight: number // standoff height under the custom PCB
  devices: SystemDevice[]
}

export interface DeviceCheck {
  deviceId: string
  deviceLabel: string
  severity: CheckSeverity
  headline: string
  explanation: string
  technicalDetail: string
  suggestedCatalogId?: string
}

export interface SystemHealth {
  status: CheckSeverity
  warningCount: number
  unverifiedCount: number
  okCount: number
  checksByDevice: Record<string, DeviceCheck>
  issues: DeviceCheck[]
}

const motor = (id: string, port: string, x: number, z: number, label: string): SystemDevice => ({
  id,
  catalogId: 'tt-motor-148',
  label,
  role: 'Wheel drive',
  bus: 'motor',
  port,
  x,
  z,
  y: -22.5,
  rot: x < 0 ? 0 : 180,
  rail: 7.4,
})

export const defaultSystem: SystemDesign = {
  name: 'Rover R1',
  chassis: { w: 150, d: 230, t: 3 },
  pcbHeight: 12,
  devices: [
    motor('m1', 'J2', -40, -78, 'Front-left motor'),
    motor('m2', 'J3', -40, 78, 'Rear-left motor'),
    motor('m3', 'J4', 40, -78, 'Front-right motor'),
    motor('m4', 'J5', 40, 78, 'Rear-right motor'),
    {
      id: 'bat',
      catalogId: 'sparkfun-2s-2200',
      label: 'Battery pack',
      role: 'Main power input',
      bus: 'power',
      port: 'J6',
      x: 0,
      z: 62,
      y: 0,
      rot: 0,
      rail: 7.4,
    },
    {
      id: 'oled',
      catalogId: 'ssd1306-096',
      label: 'Status display',
      role: 'On-rover screen',
      bus: 'i2c',
      port: 'J7',
      x: 34,
      z: -62,
      y: 6,
      rot: 0,
      rail: 3.3,
    },
    {
      id: 'imu',
      catalogId: 'mpu6050',
      label: 'Motion sensor',
      role: 'Orientation & tilt',
      bus: 'i2c',
      port: 'J7',
      x: -30,
      z: -58,
      y: 6,
      rot: 0,
      rail: 3.3,
    },
    {
      id: 'sonar',
      catalogId: 'hcsr04',
      label: 'Distance sensor',
      role: 'Front obstacle detection',
      bus: 'gpio',
      port: 'J7',
      x: 0,
      z: -104,
      y: 0,
      rot: 0,
      stand: true,
      rail: 5,
    },
    {
      id: 'leds',
      catalogId: 'ws2812b-strip',
      label: 'Status light bar',
      role: 'Rear visual indicator',
      bus: 'data',
      port: 'J7',
      x: 0,
      z: 104,
      y: 0,
      rot: 0,
      rail: 5,
    },
  ],
}

export const unitPrice = (item: CatalogItem) => item.pricing[0]?.unit ?? 0

export function systemCost(sys: SystemDesign) {
  return sys.devices.reduce((sum, d) => sum + unitPrice(byId[d.catalogId]), 0)
}

/** Whether `devices.ts` renders a dedicated 3D shape or a dimensioned breakout proxy. */
export function modelFidelity(item: CatalogItem): { kind: 'detailed' | 'proxy'; note: string } {
  const id = item.id
  if (
    (item.category === 'actuator' && item.footprint.kind === 'terminal') ||
    id === 'sg90' ||
    id === '28byj-48' ||
    id.startsWith('holder-18650') ||
    id === 'hcsr04' ||
    id.startsWith('ws2812b-strip') ||
    (item.category === 'display' && !id.startsWith('ws2812') && !id.startsWith('max7219')) ||
    item.category === 'board'
  ) {
    return {
      kind: 'detailed',
      note: item.approx
        ? 'Parametric 3D model built from catalog dimensions (some dimensions approximate).'
        : 'Parametric 3D model built from catalog dimensions.',
    }
  }
  return {
    kind: 'proxy',
    note: '3D scene displays a dimensioned breakout proxy for this replacement part.',
  }
}

/**
 * Truthful electrical compatibility analysis for one system device.
 * Separates raw battery voltage, H-bridge driver supply (VM), PWM effective voltage,
 * and regulated board rails without hiding unverified assumptions.
 */
export const analyzeDevice = checkHardware

export function analyzeSystem(sys: SystemDesign, board?: Board): SystemHealth {
  const checksByDevice: Record<string, DeviceCheck> = {}
  let warningCount = 0
  let unverifiedCount = 0
  let okCount = 0
  const issues: DeviceCheck[] = []

  for (const dev of sys.devices) {
    const check = analyzeDevice(dev, board)
    checksByDevice[dev.id] = check
    if (check.severity === 'warning') {
      warningCount++
      issues.push(check)
    } else if (check.severity === 'unverified') {
      unverifiedCount++
      issues.push(check)
    } else {
      okCount++
    }
  }

  const status: CheckSeverity =
    warningCount > 0 ? 'warning' : unverifiedCount > 0 ? 'unverified' : 'ok'

  return { status, warningCount, unverifiedCount, okCount, checksByDevice, issues }
}

export interface Alternative {
  item: CatalogItem
  score: number
  price: number
  delta: number // vs current, USD
  currentDelta: number // mA vs current
  reasons: string[]
  warnings: string[]
  current: boolean
  severity: CheckSeverity
  fidelity: 'detailed' | 'proxy'
}

/**
 * Compatible replacements for a device: same category, shares an electrical
 * interface (or is a listed alternate), evaluated with the real electrical checker.
 */
export function alternativesFor(dev: SystemDevice, board?: Board): Alternative[] {
  const cur = byId[dev.catalogId]
  if (!cur) return []
  const out: Alternative[] = []
  for (const item of catalog) {
    const isCur = item.id === cur.id
    const listed = cur.alternates.includes(item.id) || item.alternates.includes(cur.id)
    if (!isCur && item.category !== cur.category) continue
    const shared = item.interfaces.filter((i) => cur.interfaces.includes(i))
    if (!isCur && !listed && shared.length === 0) continue
    if (!isCur && !listed && item.footprint.kind !== cur.footprint.kind) continue

    const candidateCheck = analyzeDevice({ ...dev, catalogId: item.id }, board)
    const reasons: string[] = []
    const warnings: string[] = []

    if (isCur) reasons.push('Currently selected')
    if (listed) reasons.push('Catalog alternative; verify wiring and mechanics')
    if (shared.length) reasons.push(`Uses ${shared.map((s) => s.toUpperCase()).join(' / ')}`)
    if (candidateCheck.severity === 'ok') {
      reasons.push(candidateCheck.headline)
    } else if (candidateCheck.severity === 'unverified') {
      reasons.push(candidateCheck.headline)
      warnings.push(candidateCheck.headline)
    } else {
      warnings.push(candidateCheck.headline)
    }

    const fits = item.dimensions.w <= cur.dimensions.w * 1.25 && item.dimensions.h <= cur.dimensions.h * 1.25
    if (!fits) warnings.push(`Larger footprint (${item.dimensions.w}×${item.dimensions.h} mm)`)

    const fid = modelFidelity(item)
    const compatBonus = candidateCheck.severity === 'ok' ? 6 : candidateCheck.severity === 'unverified' ? 2 : -5
    const score = (isCur ? 100 : 0) + (listed ? 6 : 0) + shared.length * 2 + compatBonus + (fits ? 1 : 0) + item.popularity / 40
    const price = unitPrice(item)

    out.push({
      item,
      score,
      price,
      delta: +(price - unitPrice(cur)).toFixed(2),
      currentDelta: item.currentMa - cur.currentMa,
      reasons,
      warnings,
      current: isCur,
      severity: candidateCheck.severity,
      fidelity: fid.kind,
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 7)
}
