import type { Board } from './board'
import { byId } from './catalog'
import type { DeviceCheck, SystemDevice, CheckSeverity } from './system'

/** Screening only: nominal fits never constitute a complete safety assessment. */
export function checkHardware(dev: SystemDevice, board?: Board): DeviceCheck {
  const item = byId[dev.catalogId]
  const result = (severity: CheckSeverity, headline: string, explanation: string, suggestedCatalogId?: string): DeviceCheck => ({
    deviceId: dev.id, deviceLabel: dev.label, severity, headline, explanation,
    technicalDetail: explanation, suggestedCatalogId,
  })
  if (!item) return result('unverified', 'Specifications missing', `Unknown catalog ID: ${dev.catalogId}`)
  if (!Number.isFinite(dev.rail) || dev.rail <= 0) return result('warning', 'Invalid rail', 'Supply must be positive and finite.')
  if (dev.bus === 'power') {
    if (dev.rail < item.voltage.min || dev.rail > item.voltage.max)
      return result('warning', 'Battery cannot supply assigned voltage', 'One 18650 is up to 4.2 V, not 7.4 V.', 'sparkfun-2s-2200')
    return result('unverified', 'Battery voltage fits · protection and heat unresolved',
      '2S is 7.4 V nominal / 8.4 V full. The SparkFun pack has no protection: require fuse, undervoltage cutoff, polarity-checked J6 adapter and 2S balance charger. AMS1117 dissipates (8.4−3.3) × current: 1.53 W at 300 mA. Validate copper, ambient and ESP32 peaks. Battery current capability and total load budget remain unverified.')
  }
  if (dev.bus === 'motor') return checkMotor(dev, board, result)
  const power = board?.nets.some((n) => n.path.some((p) => p.startsWith(`${dev.port}.`)) &&
    (dev.rail === 3.3 ? n.name === '+3V3' : dev.rail === 5 && /^(VBUS|\+?5V)$/i.test(n.name)))
  if (item.voltage.min > dev.rail || item.voltage.max < dev.rail)
    return result('warning', 'Supply voltage mismatch', `Requires ${item.voltage.min}–${item.voltage.max} V, assigned ${dev.rail} V.`)
  if (item.voltage.min > 3.6 && !power)
    return result('warning', '5 V power path missing',
      'J7 exposes 3.3 V, not regulated 5 V. Add a budgeted 5 V buck and separate wiring; USB VBUS is not a battery-powered 5 V supply. HC-SR04 echo needs down-shifting; WS2812 data needs a specified 3.3-to-5 V buffer. Neither is a direct ESP32 connection.')
  if (item.voltage.logic > 3.6)
    return result('warning', 'Logic interface requires translation',
      'HC-SR04 5 V echo must not reach ESP32 GPIO. WS2812 is a data input: 3.3 V drive is not guaranteed at 5 V supply; use a suitable level-up buffer, not an echo divider. Verify the exact device datasheet.')
  return result('unverified', 'Nominal voltage fits · interface evidence missing',
    'Verify exact module schematics, pull-up voltage, pin allocation, common ground, I2C address conflicts and current budget. Generic module catalog values alone cannot prove ESP32 compatibility.')
}

type Result = (severity: CheckSeverity, headline: string, explanation: string, suggestedCatalogId?: string) => DeviceCheck
function checkMotor(dev: SystemDevice, board: Board | undefined, result: Result): DeviceCheck {
  const item = byId[dev.catalogId]
  const max = dev.rail === 7.4 ? 8.4 : dev.rail
  if (item.voltage.max < max || item.voltage.min > dev.rail)
    return result('warning', 'Motor supply outside documented range',
      `H-bridge switches ${dev.rail} V nominal / ${max} V maximum; motor catalog range ${item.voltage.min}–${item.voltage.max} V. PWM is not regulation and does not limit startup/stall current.`, 'pololu-3040')
  if (!board?.parts.some((p) => /TB6612/i.test(p.mpn)))
    return result('unverified', 'Driver evidence missing', 'Verify actual driver, VM, VCC, output and ground paths.')
  if (item.id === 'pololu-3040') return result('unverified', 'Voltage and stall screen pass · thermal/wiring checks pending',
    'Pololu documents 6 V and 12 V operation, theoretical 0.75 A stall at 12 V. This is below TB6612 1.2 A average absolute maximum per channel; 3.2 A is only a single 10 ms pulse. Two loaded channels share package heating. Verify copper, driver wiring, current protection and measured load. New mounts and 3 mm D-shaft wheels required; no safe-stall claim.')
  return result('unverified', 'Voltage fits · stall evidence missing',
    'Generic motor current estimates are not manufacturer evidence. Verify stall/startup current against TB6612 1.2 A average absolute maximum and package thermals; 3.2 A peak is a single 10 ms pulse, not a continuous rating.')
}
