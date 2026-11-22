export type PartKind =
  | 'module'
  | 'ssop'
  | 'soic'
  | 'sot223'
  | 'chip'
  | 'ecap'
  | 'terminal'
  | 'header'
  | 'usbc'
  | 'tact'
  | 'led'

export interface PriceBreak {
  qty: number
  price: number
}

export interface Part {
  ref: string
  kind: PartKind
  name: string
  mpn: string
  manufacturer: string
  description: string
  pkg: string
  /** board-space centre in mm, origin at board centre, +y toward the front edge */
  x: number
  y: number
  /** rotation in degrees, counter-clockwise seen from above */
  rot: number
  value?: string
  /** pin count for headers / terminals */
  pins?: number
  /** chip size code for passives */
  size?: '0603' | '0805'
  /** major parts get a numbered callout */
  major?: boolean
  category: string
  pricing?: PriceBreak[]
  /** id of the catalog entry this part came from (AI-generated boards) */
  catalogId?: string
}

export interface Net {
  name: string
  /** pins as "REF.pin" (1-based), routed in order */
  path: string[]
  width?: number
  layer?: 'top' | 'bottom'
  /** optional waypoints (board mm) inserted after the first pin */
  via?: [number, number][]
}

export interface Board {
  /** Provenance of the original generation inputs, never a certificate for this board or later edits. */
  researchHandoff?: {
    envelope: import('../ai/researchHandoff.ts').ResearchEnvelope
    partMapping: import('../ai/researchConstraints.ts').ResearchPartMapping[]
    scope: string
    pcbValidation: 'required'
  }
  name: string
  revision: string
  width: number
  height: number
  thickness: number
  cornerRadius: number
  holes: { x: number; y: number; d: number }[]
  parts: Part[]
  nets: Net[]
  groundVias: [number, number][]
}

const stdPrice = (base: number): PriceBreak[] => [
  { qty: 1, price: base },
  { qty: 25, price: +(base * 0.86).toFixed(3) },
  { qty: 100, price: +(base * 0.71).toFixed(3) },
  { qty: 500, price: +(base * 0.64).toFixed(3) },
  { qty: 1000, price: +(base * 0.6).toFixed(3) },
]

const passive = (
  ref: string,
  x: number,
  y: number,
  rot: number,
  value: string,
  kind: 'cap' | 'res',
  size: '0603' | '0805' = '0805',
): Part => ({
  ref,
  kind: 'chip',
  size,
  name: kind === 'cap' ? `${value} MLCC` : `${value} resistor`,
  mpn: kind === 'cap' ? `CL21A${value.replace(/[^0-9]/g, '')}KAQNNNE` : `RC${size}FR-07${value}L`,
  manufacturer: kind === 'cap' ? 'Samsung Electro-Mechanics' : 'Yageo',
  description: kind === 'cap' ? `${value} ±10% 25V X5R ceramic capacitor` : `${value} ±1% 1/8W thick film resistor`,
  pkg: size,
  x,
  y,
  rot,
  value,
  category: kind === 'cap' ? 'Capacitor' : 'Resistor',
  pricing: stdPrice(kind === 'cap' ? 0.012 : 0.004),
})

export const board: Board = {
  name: 'ESP32 Dual Motor Controller',
  revision: 'A2',
  width: 80,
  height: 60,
  thickness: 1.6,
  cornerRadius: 3,
  holes: [
    { x: -36, y: -26, d: 3.2 },
    { x: 36, y: -26, d: 3.2 },
    { x: -36, y: 26, d: 3.2 },
    { x: 36, y: 26, d: 3.2 },
  ],
  parts: [
    {
      ref: 'U1', kind: 'module', name: 'ESP32-WROOM-32E', mpn: 'ESP32-WROOM-32E-N8', manufacturer: 'Espressif',
      description: 'Wi-Fi + Bluetooth LE module, dual-core 240 MHz, 8 MB flash, PCB antenna',
      pkg: 'SMD-38', x: 0, y: -8, rot: 0, major: true, category: 'RF module', pricing: stdPrice(3.12),
    },
    {
      ref: 'U2', kind: 'ssop', name: 'TB6612FNG', mpn: 'TB6612FNG(O,C,8,EL)', manufacturer: 'Toshiba',
      description: 'Dual H-bridge motor driver, 1.2 A per channel, 15 V', pkg: 'SSOP-24',
      x: -21, y: 12, rot: 0, major: true, category: 'Motor driver', pricing: stdPrice(2.752),
    },
    {
      ref: 'U3', kind: 'ssop', name: 'TB6612FNG', mpn: 'TB6612FNG(O,C,8,EL)', manufacturer: 'Toshiba',
      description: 'Dual H-bridge motor driver, 1.2 A per channel, 15 V', pkg: 'SSOP-24',
      x: 21, y: 12, rot: 0, major: true, category: 'Motor driver', pricing: stdPrice(2.752),
    },
    {
      ref: 'U4', kind: 'sot223', name: 'AMS1117-3.3', mpn: 'AMS1117-3.3', manufacturer: 'Advanced Monolithic Systems',
      description: '1 A low-dropout linear regulator, fixed 3.3 V output', pkg: 'SOT-223',
      x: -21, y: -20, rot: 0, major: true, category: 'Power', pricing: stdPrice(0.118),
    },
    {
      ref: 'U5', kind: 'soic', name: 'CH340C', mpn: 'CH340C', manufacturer: 'WCH',
      description: 'USB to UART bridge with internal oscillator', pkg: 'SOIC-16',
      x: 18, y: -14, rot: 0, major: true, category: 'Interface', pricing: stdPrice(0.42),
    },
    {
      ref: 'J1', kind: 'usbc', name: 'USB-C receptacle', mpn: 'TYPE-C-31-M-12', manufacturer: 'Korean Hroparts',
      description: '16-pin USB Type-C receptacle, mid-mount SMD', pkg: 'USB-C-16P',
      x: 0, y: 26.6, rot: 0, major: true, category: 'Connector', pricing: stdPrice(0.236),
    },
    {
      ref: 'J2', kind: 'terminal', pins: 2, name: 'Motor A terminal', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa',
      description: '2-position screw terminal, 5.08 mm pitch, 16 A', pkg: 'THT 2P 5.08',
      x: -34.4, y: 3, rot: 90, major: true, category: 'Connector', pricing: stdPrice(0.096),
    },
    {
      ref: 'J3', kind: 'terminal', pins: 2, name: 'Motor B terminal', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa',
      description: '2-position screw terminal, 5.08 mm pitch, 16 A', pkg: 'THT 2P 5.08',
      x: -34.4, y: 15, rot: 90, category: 'Connector', pricing: stdPrice(0.096),
    },
    {
      ref: 'J4', kind: 'terminal', pins: 2, name: 'Motor C terminal', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa',
      description: '2-position screw terminal, 5.08 mm pitch, 16 A', pkg: 'THT 2P 5.08',
      x: 34.4, y: 3, rot: -90, category: 'Connector', pricing: stdPrice(0.096),
    },
    {
      ref: 'J5', kind: 'terminal', pins: 2, name: 'Motor D terminal', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa',
      description: '2-position screw terminal, 5.08 mm pitch, 16 A', pkg: 'THT 2P 5.08',
      x: 34.4, y: 15, rot: -90, category: 'Connector', pricing: stdPrice(0.096),
    },
    {
      ref: 'J6', kind: 'terminal', pins: 2, name: 'Power input', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa',
      description: '2-position screw terminal, 6–12 V supply input', pkg: 'THT 2P 5.08',
      x: -34.4, y: -12, rot: 90, major: true, category: 'Connector', pricing: stdPrice(0.096),
    },
    {
      ref: 'J7', kind: 'header', pins: 6, name: 'I²C / GPIO header', mpn: 'PZ254V-11-06P', manufacturer: 'XFCN',
      description: '1×6 male pin header, 2.54 mm pitch', pkg: 'THT 1×6 2.54',
      x: 32, y: -16, rot: 0, major: true, category: 'Connector', pricing: stdPrice(0.034),
    },
    {
      ref: 'C1', kind: 'ecap', name: '220 µF electrolytic', mpn: 'RVT1E221M0810', manufacturer: 'Rubycon',
      description: '220 µF 25 V aluminium electrolytic, 8 × 10 mm', pkg: 'Radial 8 mm', value: '220µF',
      x: -11, y: 15.5, rot: 0, major: true, category: 'Capacitor', pricing: stdPrice(0.081),
    },
    {
      ref: 'C2', kind: 'ecap', name: '220 µF electrolytic', mpn: 'RVT1E221M0810', manufacturer: 'Rubycon',
      description: '220 µF 25 V aluminium electrolytic, 8 × 10 mm', pkg: 'Radial 8 mm', value: '220µF',
      x: 11, y: 15.5, rot: 0, category: 'Capacitor', pricing: stdPrice(0.081),
    },
    {
      ref: 'SW1', kind: 'tact', name: 'EN button', mpn: 'TS-1187A-B-A-B', manufacturer: 'XKB',
      description: '6 × 6 mm tactile switch, reset (EN)', pkg: 'SMD 6×6',
      x: -14, y: 25, rot: 0, major: true, category: 'Switch', pricing: stdPrice(0.021),
    },
    {
      ref: 'SW2', kind: 'tact', name: 'BOOT button', mpn: 'TS-1187A-B-A-B', manufacturer: 'XKB',
      description: '6 × 6 mm tactile switch, boot mode (IO0)', pkg: 'SMD 6×6',
      x: 14, y: 25, rot: 0, category: 'Switch', pricing: stdPrice(0.021),
    },
    {
      ref: 'D1', kind: 'led', size: '0603', name: 'Status LED', mpn: '19-217/GHC-YR1S2/3T', manufacturer: 'Everlight',
      description: 'White 0603 indicator LED', pkg: '0603', x: 23, y: -25, rot: 0, category: 'LED', pricing: stdPrice(0.028),
    },
    {
      ref: 'D2', kind: 'led', size: '0603', name: 'Power LED', mpn: '19-217/GHC-YR1S2/3T', manufacturer: 'Everlight',
      description: 'White 0603 indicator LED', pkg: '0603', x: 27, y: -25, rot: 0, category: 'LED', pricing: stdPrice(0.028),
    },
    passive('C3', -4, 7.6, 0, '10uF', 'cap'),
    passive('C4', 4, 7.6, 0, '100nF', 'cap'),
    passive('C5', -25.5, 19.5, 90, '100nF', 'cap'),
    passive('C6', -16.5, 19.5, 90, '10uF', 'cap'),
    passive('C7', 16.5, 19.5, 90, '100nF', 'cap'),
    passive('C8', 25.5, 19.5, 90, '10uF', 'cap'),
    passive('C9', -27, -26, 0, '10uF', 'cap'),
    passive('C10', -15, -26, 0, '22uF', 'cap'),
    passive('C11', 13, -22.5, 90, '100nF', 'cap'),
    passive('R1', 23, -21.5, 90, '1k', 'res', '0603'),
    passive('R2', 27, -21.5, 90, '1k', 'res', '0603'),
    passive('R3', -10.5, 3.5, 90, '10k', 'res', '0603'),
    passive('R4', 10.5, 3.5, 90, '10k', 'res', '0603'),
    passive('R5', -5, 21, 0, '5k1', 'res', '0603'),
    passive('R6', 5, 21, 0, '5k1', 'res', '0603'),
  ],
  nets: [
    // power entry and regulator
    { name: 'VIN', path: ['J6.1', 'C9.1', 'U4.3'], width: 1.2 },
    { name: '+3V3', path: ['U4.4', 'C10.1'], width: 1.0 },
    { name: '+3V3', path: ['C10.1', 'U1.2'], width: 0.8, via: [[-12, -20]] },
    { name: 'VM', path: ['J6.1', 'U2.13'], width: 1.0, layer: 'bottom', via: [[-30, 8]] },
    { name: 'VM', path: ['U2.24', 'C6.1'], width: 0.8 },
    { name: 'VM', path: ['C1.1', 'C2.1'], width: 1.0, layer: 'bottom' },
    { name: 'VM', path: ['C2.1', 'U3.1'], width: 0.8 },
    { name: '+3V3', path: ['U1.2', 'C3.1'], width: 0.5, via: [[-12, 7.6]] },
    // ESP32 → driver A (left column of module to right column of U2)
    { name: 'AIN1', path: ['U1.4', 'U2.21'], via: [[-14, -3.8]] },
    { name: 'AIN2', path: ['U1.5', 'U2.20'], via: [[-13.2, -2.5]] },
    { name: 'PWMA', path: ['U1.6', 'U2.19'], via: [[-12.4, -1.3]] },
    { name: 'BIN1', path: ['U1.7', 'U2.18'], via: [[-11.6, 0]] },
    { name: 'BIN2', path: ['U1.8', 'U2.17'], via: [[-10.8, 1.2]] },
    { name: 'PWMB', path: ['U1.9', 'U2.16'] },
    // ESP32 → driver B (right column of module to left column of U3)
    { name: 'CIN1', path: ['U1.24', 'U3.4'], via: [[14, -3.8]] },
    { name: 'CIN2', path: ['U1.23', 'U3.5'], via: [[13.2, -2.5]] },
    { name: 'PWMC', path: ['U1.22', 'U3.6'], via: [[12.4, -1.3]] },
    { name: 'DIN1', path: ['U1.21', 'U3.7'], via: [[11.6, 0]] },
    { name: 'DIN2', path: ['U1.20', 'U3.8'], via: [[10.8, 1.2]] },
    { name: 'PWMD', path: ['U1.19', 'U3.9'] },
    // driver outputs → screw terminals
    { name: 'AO1', path: ['U2.1', 'J2.1'], width: 0.8 },
    { name: 'AO2', path: ['U2.3', 'J2.2'], width: 0.8 },
    { name: 'BO1', path: ['U2.10', 'J3.1'], width: 0.8 },
    { name: 'BO2', path: ['U2.12', 'J3.2'], width: 0.8 },
    { name: 'CO1', path: ['U3.24', 'J4.2'], width: 0.8 },
    { name: 'CO2', path: ['U3.22', 'J4.1'], width: 0.8 },
    { name: 'DO1', path: ['U3.15', 'J5.2'], width: 0.8 },
    { name: 'DO2', path: ['U3.13', 'J5.1'], width: 0.8 },
    // USB → CH340 → ESP32 UART
    { name: 'USB_D+', path: ['J1.6', 'U5.5'], width: 0.3, layer: 'bottom', via: [[2, 4], [9, -6]] },
    { name: 'USB_D-', path: ['J1.7', 'U5.6'], width: 0.3, layer: 'bottom', via: [[2.6, 4.4], [9.6, -5.4]] },
    { name: 'U0TXD', path: ['U5.2', 'U1.36'] },
    { name: 'U0RXD', path: ['U5.3', 'U1.35'] },
    { name: 'CC1', path: ['J1.4', 'R5.1'], width: 0.3 },
    { name: 'CC2', path: ['J1.9', 'R6.2'], width: 0.3 },
    { name: 'VBUS', path: ['J1.1', 'C2.2'], width: 0.8, layer: 'bottom', via: [[6, 22]] },
    // header, buttons, LEDs
    { name: 'SDA', path: ['U1.27', 'J7.3'] },
    { name: 'SCL', path: ['U1.28', 'J7.4'] },
    { name: '+3V3', path: ['J7.1', 'U5.16'], width: 0.5 },
    { name: 'EN', path: ['SW1.2', 'R3.2'], via: [[-10.5, 22]] },
    { name: 'EN', path: ['R3.1', 'U1.3'] },
    { name: 'IO0', path: ['SW2.1', 'R4.2'], via: [[10.5, 22]] },
    { name: 'IO0', path: ['R4.1', 'U1.25'] },
    { name: 'LED1', path: ['R1.2', 'D1.1'], width: 0.3 },
    { name: 'LED2', path: ['R2.2', 'D2.1'], width: 0.3 },
    { name: 'LED1', path: ['U1.37', 'R1.1'], via: [[16, -20.6]] },
    { name: '+3V3', path: ['U5.16', 'C11.2'], width: 0.4 },
  ],
  groundVias: [
    [-30, -4], [-26, 0], [-16, -12], [-6, 12], [6, 12], [-28, 26], [28, 26],
    [-8, 26.5], [8, 26.5], [30, -6], [26, -4], [16, 6], [-16, 6], [0, -26], [-6, -26],
    [6, -26], [30, 8], [-30, 20], [30, 20], [24, -10], [-24, -6], [36, -10], [-20, 26],
    [20, 26], [-2, 12], [2, 12],
  ],
}
