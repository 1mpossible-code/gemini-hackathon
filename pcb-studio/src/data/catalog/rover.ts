import type { CatalogItem } from './types'
import { peripherals } from './peripherals'

const base = (id: string) => peripherals.find((item) => item.id === id)!

/** Prices are budgeting estimates, not live supplier quotes. */
export const roverParts: CatalogItem[] = [
  {
    ...base('holder-18650'),
    id: 'sparkfun-2s-2200', name: 'SparkFun 2200 mAh 7.4 V 2S pack',
    manufacturer: 'SparkFun', mpn: '2200mAh 7.4V pack',
    description: 'Two-cell series pack, 7.4 V nominal / 8.4 V full. No built-in protection. Requires a 2S balance charger, fuse, undervoltage cutoff and polarity-checked discharge adapter to J6.',
    voltage: { min: 6, max: 8.4, logic: 0 },
    pricing: [{ qty: 1, unit: 25 }],
    datasheetUrl: 'https://www.sparkfun.com/lithium-ion-battery-2200mah-7-4v.html',
    alternates: ['holder-18650'],
    notes: '6 V is a design cutoff assumption, not a manufacturer protection threshold. Dimensions inherited only as a placement estimate; confirm pack fit. Charger/protection/adapter/cells are not additional included accessories.',
    approx: true, approxFields: ['dimensions', 'mpn', 'pricing', 'voltage.min', 'footprint'],
  },
  {
    ...base('tt-motor-148'),
    id: 'pololu-3040', name: 'Pololu 75:1 Micro Metal Gearmotor HPCB 12V',
    manufacturer: 'Pololu', mpn: '3040',
    description: '12 V motor; manufacturer also characterizes operation at 6 V. 80 mA no-load at 12 V; theoretical stall 0.75 A at 12 V. Not a TT mechanical drop-in: requires 3 mm D-shaft wheels/hubs and new mounts.',
    voltage: { min: 6, max: 12, logic: 0 }, currentMa: 80,
    dimensions: { w: 26, h: 12, thickness: 10 },
    pricing: [{ qty: 1, unit: 25 }],
    datasheetUrl: 'https://www.pololu.com/product/3040/specs',
    alternates: ['tt-motor-148', 'n20-gearmotor-100', 'jga25-370-12v'],
    notes: '80 mA is no-load, not rover running current. Stall is damaging; 0.75 A is not a permitted continuous motor operating point.',
    approx: true, approxFields: ['dimensions', 'pricing'],
  },
]
