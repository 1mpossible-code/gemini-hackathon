import type { Part, PartKind, PriceBreak } from '@/data/board'

/**
 * Minimal built-in parts list used only when src/data/catalog is missing or
 * unreadable. Every entry renders with an existing PartKind.
 */
export interface FallbackEntry {
  id: string
  kind: PartKind
  name: string
  mpn: string
  manufacturer: string
  description: string
  pkg: string
  category: string
  interfaces?: string[]
  voltage?: string
  current?: string
  value?: string
  pins?: number
  size?: '0603' | '0805'
  pinNames?: string[]
  price: number
}

const price = (base: number): PriceBreak[] => [
  { qty: 1, price: base },
  { qty: 100, price: +(base * 0.71).toFixed(3) },
  { qty: 1000, price: +(base * 0.6).toFixed(3) },
]

const ESP32_PINS = [
  'GND', '3V3', 'EN', 'IO36', 'IO39', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27', 'IO14', 'IO12',
  'GND', 'IO13', 'SD2', 'SD3', 'CMD', 'CLK', 'SD0', 'SD1', 'IO15', 'IO2',
  'IO0', 'IO4', 'IO16', 'IO17', 'IO5', 'IO18', 'IO19', 'NC', 'IO21', 'RXD0', 'TXD0', 'IO22', 'IO23', 'GND',
]

const TB6612_PINS = [
  'AO1', 'AO1', 'PGND1', 'PGND1', 'AO2', 'AO2', 'BO2', 'BO2', 'PGND2', 'PGND2', 'BO1', 'BO1',
  'VM2', 'VM3', 'PWMB', 'BIN2', 'BIN1', 'GND', 'STBY', 'VCC', 'AIN1', 'AIN2', 'PWMA', 'VM1',
]

const CH340_PINS = ['GND', 'TXD', 'RXD', 'V3', 'UD+', 'UD-', 'NC', 'NC', 'CTS', 'DSR', 'RI', 'DCD', 'DTR', 'RTS', 'R232', 'VCC']

const USBC_PINS = ['VBUS', 'GND', 'SBU1', 'CC1', 'DN2', 'DP1', 'DN1', 'DP2', 'CC2', 'SBU2', 'GND', 'VBUS', 'SHIELD', 'SHIELD', 'SHIELD', 'SHIELD']

export const FALLBACK_VERSION = 'fallback-1'

export const FALLBACK_CATALOG: FallbackEntry[] = [
  { id: 'esp32-wroom-32e', kind: 'module', name: 'ESP32-WROOM-32E', mpn: 'ESP32-WROOM-32E-N8', manufacturer: 'Espressif', description: 'Wi-Fi + BLE module, dual-core 240 MHz, 8 MB flash', pkg: 'SMD-38', category: 'MCU module', interfaces: ['WiFi', 'BLE', 'I2C', 'SPI', 'UART', 'PWM', 'ADC'], voltage: '3.0-3.6V', current: '500mA peak', pinNames: ESP32_PINS, price: 3.12 },
  { id: 'tb6612fng', kind: 'ssop', name: 'TB6612FNG', mpn: 'TB6612FNG(O,C,8,EL)', manufacturer: 'Toshiba', description: 'Dual H-bridge DC motor driver, 1.2 A/ch, 15 V', pkg: 'SSOP-24', category: 'Motor driver', interfaces: ['PWM', 'GPIO'], voltage: 'VM 2.5-13.5V, VCC 2.7-5.5V', current: '1.2A/ch', pinNames: TB6612_PINS, price: 2.75 },
  { id: 'ams1117-3.3', kind: 'sot223', name: 'AMS1117-3.3', mpn: 'AMS1117-3.3', manufacturer: 'Advanced Monolithic Systems', description: '1 A LDO regulator, 3.3 V fixed', pkg: 'SOT-223', category: 'Power', interfaces: ['power'], voltage: 'in 4.5-15V, out 3.3V', current: '1A', pinNames: ['GND', 'VOUT', 'VIN', 'VOUT_TAB'], price: 0.12 },
  { id: 'ch340c', kind: 'soic', name: 'CH340C', mpn: 'CH340C', manufacturer: 'WCH', description: 'USB to UART bridge, internal oscillator', pkg: 'SOIC-16', category: 'Interface', interfaces: ['USB', 'UART'], voltage: '3.3-5V', pinNames: CH340_PINS, price: 0.42 },
  { id: 'usb-c-16p', kind: 'usbc', name: 'USB-C receptacle', mpn: 'TYPE-C-31-M-12', manufacturer: 'Korean Hroparts', description: '16-pin USB Type-C receptacle', pkg: 'USB-C-16P', category: 'Connector', interfaces: ['USB', 'power'], voltage: '5V', current: '3A', pinNames: USBC_PINS, price: 0.24 },
  { id: 'terminal-2p-5.08', kind: 'terminal', pins: 2, name: '2P screw terminal', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa', description: '2-position screw terminal, 5.08 mm, for motors or power', pkg: 'THT 2P 5.08', category: 'Connector', interfaces: ['power', 'motor'], current: '16A', pinNames: ['1', '2'], price: 0.1 },
  { id: 'terminal-3p-5.08', kind: 'terminal', pins: 3, name: '3P screw terminal', mpn: 'KF301-5.0-3P', manufacturer: 'Cixi Kefa', description: '3-position screw terminal, 5.08 mm', pkg: 'THT 3P 5.08', category: 'Connector', interfaces: ['power'], current: '16A', pinNames: ['1', '2', '3'], price: 0.14 },
  { id: 'header-1x4', kind: 'header', pins: 4, name: '1×4 pin header', mpn: 'PZ254V-11-04P', manufacturer: 'XFCN', description: '1×4 male header 2.54 mm (I2C/UART breakout)', pkg: 'THT 1×4 2.54', category: 'Connector', interfaces: ['I2C', 'UART', 'GPIO'], price: 0.03 },
  { id: 'header-1x6', kind: 'header', pins: 6, name: '1×6 pin header', mpn: 'PZ254V-11-06P', manufacturer: 'XFCN', description: '1×6 male header 2.54 mm', pkg: 'THT 1×6 2.54', category: 'Connector', interfaces: ['GPIO', 'I2C', 'SPI'], price: 0.04 },
  { id: 'gy521-mpu6050', kind: 'header', pins: 8, name: 'MPU-6050 IMU module socket', mpn: 'GY-521', manufacturer: 'Generic', description: '6-axis IMU (MPU-6050) breakout on 1×8 header: VCC GND SCL SDA XDA XCL AD0 INT', pkg: 'THT 1×8 2.54', category: 'Sensor', interfaces: ['I2C'], voltage: '3.3-5V', pinNames: ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'], price: 1.6 },
  { id: 'line-sensor-5ch', kind: 'header', pins: 7, name: '5-ch IR line sensor connector', mpn: 'PZ254V-11-07P', manufacturer: 'XFCN', description: 'Header for 5-channel TCRT5000 line sensor bar: VCC GND S1..S5 (analog)', pkg: 'THT 1×7 2.54', category: 'Sensor', interfaces: ['ADC', 'GPIO'], voltage: '3.3-5V', pinNames: ['VCC', 'GND', 'S1', 'S2', 'S3', 'S4', 'S5'], price: 0.05 },
  { id: 'ecap-220u-25v', kind: 'ecap', name: '220 µF electrolytic', mpn: 'RVT1E221M0810', manufacturer: 'Rubycon', description: '220 µF 25 V bulk capacitor', pkg: 'Radial 8 mm', category: 'Capacitor', value: '220µF', voltage: '25V', pinNames: ['+', '-'], price: 0.08 },
  { id: 'mlcc-100n-0805', kind: 'chip', size: '0805', name: '100 nF MLCC', mpn: 'CL21B104KBCNNNC', manufacturer: 'Samsung Electro-Mechanics', description: '100 nF 50 V X7R decoupling', pkg: '0805', category: 'Capacitor', value: '100nF', pinNames: ['1', '2'], price: 0.01 },
  { id: 'mlcc-10u-0805', kind: 'chip', size: '0805', name: '10 µF MLCC', mpn: 'CL21A106KAYNNNE', manufacturer: 'Samsung Electro-Mechanics', description: '10 µF 25 V X5R bulk/decoupling', pkg: '0805', category: 'Capacitor', value: '10uF', pinNames: ['1', '2'], price: 0.02 },
  { id: 'res-10k-0603', kind: 'chip', size: '0603', name: '10 kΩ resistor', mpn: 'RC0603FR-0710KL', manufacturer: 'Yageo', description: '10 kΩ 1% pull-up', pkg: '0603', category: 'Resistor', value: '10k', pinNames: ['1', '2'], price: 0.004 },
  { id: 'res-1k-0603', kind: 'chip', size: '0603', name: '1 kΩ resistor', mpn: 'RC0603FR-071KL', manufacturer: 'Yageo', description: '1 kΩ 1% LED limiter', pkg: '0603', category: 'Resistor', value: '1k', pinNames: ['1', '2'], price: 0.004 },
  { id: 'res-5k1-0603', kind: 'chip', size: '0603', name: '5.1 kΩ resistor', mpn: 'RC0603FR-075K1L', manufacturer: 'Yageo', description: '5.1 kΩ USB-C CC pull-down', pkg: '0603', category: 'Resistor', value: '5k1', pinNames: ['1', '2'], price: 0.004 },
  { id: 'res-4k7-0603', kind: 'chip', size: '0603', name: '4.7 kΩ resistor', mpn: 'RC0603FR-074K7L', manufacturer: 'Yageo', description: '4.7 kΩ I2C pull-up', pkg: '0603', category: 'Resistor', value: '4k7', pinNames: ['1', '2'], price: 0.004 },
  { id: 'led-0603', kind: 'led', size: '0603', name: 'Indicator LED', mpn: '19-217/GHC-YR1S2/3T', manufacturer: 'Everlight', description: '0603 status LED', pkg: '0603', category: 'LED', pinNames: ['A', 'K'], price: 0.03 },
  { id: 'tact-6x6', kind: 'tact', name: 'Tactile switch', mpn: 'TS-1187A-B-A-B', manufacturer: 'XKB', description: '6×6 mm tactile switch (reset/boot/user)', pkg: 'SMD 6×6', category: 'Switch', pinNames: ['A1', 'B1', 'A2', 'B2'], price: 0.02 },
]

export function fallbackToPart(e: FallbackEntry, ref: string): Part {
  return {
    ref,
    kind: e.kind,
    name: e.name,
    mpn: e.mpn,
    manufacturer: e.manufacturer,
    description: e.description,
    pkg: e.pkg,
    x: 0,
    y: 0,
    rot: 0,
    value: e.value,
    pins: e.pins,
    size: e.size,
    category: e.category,
    pricing: price(e.price),
    catalogId: e.id,
  }
}
