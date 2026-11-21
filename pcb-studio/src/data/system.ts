// System-scale assembly: the custom PCB plus the off-board devices it drives.
// Coordinates in mm, world X right, Z toward the viewer (rover front is -Z).
import { byId, catalog, type CatalogItem } from './catalog'

export type Bus = 'power' | 'motor' | 'i2c' | 'gpio' | 'data'

export const BUS_COLOR: Record<Bus, string> = {
  power: '#ffffff',
  motor: '#d4d4d4',
  i2c: '#a3a3a3',
  gpio: '#737373',
  data: '#e5e5e5',
}

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
  /** Rail the device is powered from, used for compatibility checks. */
  rail: number
}

export interface SystemDesign {
  name: string
  chassis: { w: number; d: number; t: number }
  pcbHeight: number // standoff height under the custom PCB
  devices: SystemDevice[]
}

const motor = (id: string, port: string, x: number, z: number, label: string): SystemDevice => ({
  id, catalogId: 'tt-motor-148', label, role: `Drive · ${port}`, bus: 'motor', port,
  x, z, y: -22.5, rot: x < 0 ? 0 : 180, rail: 7.4,
})

export const defaultSystem: SystemDesign = {
  name: 'Rover R1',
  chassis: { w: 150, d: 230, t: 3 },
  pcbHeight: 12,
  devices: [
    motor('m1', 'J2', -40, -78, 'Front-left drive'),
    motor('m2', 'J3', -40, 78, 'Rear-left drive'),
    motor('m3', 'J4', 40, -78, 'Front-right drive'),
    motor('m4', 'J5', 40, 78, 'Rear-right drive'),
    { id: 'bat', catalogId: 'holder-18650', label: 'Battery', role: 'Power · 2S Li-ion', bus: 'power', port: 'J6', x: 0, z: 62, y: 0, rot: 0, rail: 7.4 },
    { id: 'oled', catalogId: 'ssd1306-096', label: 'Status display', role: 'HMI · I²C 0x3C', bus: 'i2c', port: 'J7', x: 34, z: -62, y: 6, rot: 0, rail: 3.3 },
    { id: 'imu', catalogId: 'mpu6050', label: 'IMU', role: 'Heading · I²C 0x68', bus: 'i2c', port: 'J7', x: -30, z: -58, y: 6, rot: 0, rail: 3.3 },
    { id: 'sonar', catalogId: 'hcsr04', label: 'Range finder', role: 'Obstacle · GPIO', bus: 'gpio', port: 'J7', x: 0, z: -104, y: 0, rot: 0, stand: true, rail: 5 },
    { id: 'leds', catalogId: 'ws2812b-strip', label: 'Light bar', role: 'Lighting · 1-wire', bus: 'data', port: 'J7', x: 0, z: 104, y: 0, rot: 0, rail: 5 },
  ],
}

export const unitPrice = (item: CatalogItem) => item.pricing[0]?.unit ?? 0

export function systemCost(sys: SystemDesign) {
  return sys.devices.reduce((sum, d) => sum + unitPrice(byId[d.catalogId]), 0)
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
}

/**
 * Compatible replacements for a device: same category, shares an electrical
 * interface (or is a listed alternate), and runs from the device's rail.
 */
export function alternativesFor(dev: SystemDevice): Alternative[] {
  const cur = byId[dev.catalogId]
  if (!cur) return []
  const out: Alternative[] = []
  for (const item of catalog) {
    const isCur = item.id === cur.id
    const listed = cur.alternates.includes(item.id) || item.alternates.includes(cur.id)
    if (!isCur && item.category !== cur.category) continue
    const shared = item.interfaces.filter((i) => cur.interfaces.includes(i))
    if (!isCur && !listed && shared.length === 0) continue
    // keep motors with motors, displays with displays of similar kind
    if (!isCur && !listed && item.footprint.kind !== cur.footprint.kind) continue
    const reasons: string[] = []
    const warnings: string[] = []
    if (isCur) reasons.push('Current selection')
    if (listed) reasons.push('Drop-in alternate')
    if (shared.length) reasons.push(`Shares ${shared.map((s) => s.toUpperCase()).join(' / ')}`)
    const railOk = item.voltage.min <= dev.rail + 0.05 && item.voltage.max >= dev.rail - 0.05
    if (railOk) reasons.push(`Runs on ${dev.rail} V rail`)
    else warnings.push(`Needs ${item.voltage.min}–${item.voltage.max} V, rail is ${dev.rail} V`)
    if (item.voltage.logic > 3.6 && dev.bus !== 'motor' && dev.bus !== 'power') warnings.push(`${item.voltage.logic} V logic — level shift to ESP32`)
    const fits = item.dimensions.w <= cur.dimensions.w * 1.25 && item.dimensions.h <= cur.dimensions.h * 1.25
    if (!fits) warnings.push(`Larger: ${item.dimensions.w}×${item.dimensions.h} mm`)
    const score = (isCur ? 100 : 0) + (listed ? 6 : 0) + shared.length * 2 + (railOk ? 3 : -4) + (fits ? 1 : 0) + item.popularity / 40
    const price = unitPrice(item)
    out.push({
      item, score, price, delta: price - unitPrice(cur), currentDelta: item.currentMa - cur.currentMa,
      reasons, warnings, current: isCur,
    })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 7)
}
