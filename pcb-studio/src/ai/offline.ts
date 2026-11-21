import type { LlmCall } from './types'

/**
 * Deterministic, key-free stand-in for the Gemini calls made by runPipeline.
 *
 * The planner keyword-matches the request against the catalog digest that the
 * pipeline puts in the plan prompt and designs a complete ESP32 board (power
 * entry, 3V3 regulator, decoupling, reset/boot, status LED, one connector or
 * module per off-board device). It remembers the connection intent of every
 * part it planned, so the netlist call can wire them exactly; parts it did not
 * plan are wired by pin-name matching on the "Parts and pins" block.
 *
 * Create one instance per generation (the plan → nets hand-off is kept in the
 * closure).
 */

// ---------------------------------------------------------------- types

interface DigestItem {
  id: string
  name: string
  category: string
  interfaces: string[]
  pads: number
  desc: string
}

/** Net token: a net name, or "@GPIO:NAME" / "@ADC:NAME" = allocate an MCU pin into net NAME. */
type Tok = string | null

interface Intent {
  ref: string
  catalogId: string
  purpose: string
  role: 'connector' | 'mcu' | 'ic' | 'power' | 'decoupling' | 'passive' | 'indicator' | 'switch' | 'other'
  near?: string
  edge?: 'front' | 'back' | 'left' | 'right'
  dev: 'mcu' | 'reg' | 'usb' | 'tb6612' | 'stepdrv' | 'device' | 'fixed'
  /** explicit pin number → net token */
  nets?: Record<number, Tok>
  /** pin function names overriding whatever the block lists */
  pinFns?: string[]
  /** supply rail for "device" parts */
  rail?: string
  /** net-name prefix for signals of "device" parts */
  label?: string
  adc?: boolean
  /** tb6612: the two motor labels driven by A and B */
  motors?: [string, string]
  /** rails seen by the mcu */
  inRail?: string
}

interface BlockPart {
  ref: string
  name: string
  kind: string
  pins: number
  names?: string[]
}

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---------------------------------------------------------------- default pinouts (pad order of the rendered footprints)

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

const IO_POOL = ['IO25', 'IO26', 'IO27', 'IO14', 'IO13', 'IO4', 'IO16', 'IO17', 'IO5', 'IO18', 'IO19', 'IO23', 'IO32', 'IO33', 'IO2', 'IO15']
const ADC_POOL = ['IO36', 'IO39', 'IO34', 'IO35', 'IO32', 'IO33']

const norm = (s: string) =>
  s
    .replace(/\(.*?\)/g, '')
    .replace(/−/g, '-')
    .trim()
    .toUpperCase()
const netName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_+\-]/g, '_').replace(/_+/g, '_').slice(0, 32)

// ---------------------------------------------------------------- parsing

function parseDigest(prompt: string): DigestItem[] {
  const i = prompt.indexOf('Catalog (')
  const body = i >= 0 ? prompt.slice(prompt.indexOf('\n', i) + 1) : prompt
  const out: DigestItem[] = []
  for (const line of body.split('\n')) {
    const f = line.split(' | ')
    if (f.length < 9) continue
    out.push({
      id: f[0].trim(),
      name: f[1].trim(),
      category: f[2].trim(),
      interfaces: f[3] === '-' ? [] : f[3].toLowerCase().split('/'),
      pads: parseInt(f[7], 10) || 0,
      desc: f.slice(8).join(' | '),
    })
  }
  return out
}

const KINDS = 'module|ssop|soic|sot223|chip|ecap|terminal|header|usbc|tact|led'
const HEAD_RE = new RegExp(`^([A-Z]{1,3}\\d{1,3}) = (.*?) \\((.*), (${KINDS})(?:, [^)]*)?\\)`)

function parseBlock(prompt: string): BlockPart[] {
  const i = prompt.indexOf('Parts and pins:')
  if (i < 0) return []
  const lines = prompt.slice(i).split('\n').slice(1)
  const out: BlockPart[] = []
  for (let k = 0; k < lines.length; k++) {
    const m = HEAD_RE.exec(lines[k])
    if (!m) {
      if (out.length && !lines[k].trim()) break
      continue
    }
    const part: BlockPart = { ref: m[1], name: m[2], kind: m[4], pins: 0 }
    const pl = (lines[k + 1] ?? '').trim()
    const range = /^pins 1-(\d+)$/.exec(pl)
    if (range) part.pins = Number(range[1])
    else if (/^1 /.test(pl)) {
      const names = pl.split(/, (?=\d+ )/).map((x) => x.replace(/^\d+ /, ''))
      part.pins = names.length
      part.names = names
    }
    if (part.pins) k++
    out.push(part)
  }
  return out
}

// ---------------------------------------------------------------- planner

const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, dual: 2, quad: 4 }

function countOf(q: string, noun: string, dflt: number): number {
  const m = new RegExp(`\\b(\\d+|one|two|three|four|five|six|eight|dual|quad)[\\s-]*(?:x\\s*)?(?:channel\\s+|ch\\s+)?(?:\\w+\\s+){0,2}${noun}`).exec(q)
  if (!m) return dflt
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORDNUM[m[1]]
  return Math.max(1, Math.min(n || dflt, 6))
}

interface Device {
  ids: (string | RegExp)[]
  label: string
  purpose: string
  rail?: '5V'
  adc?: boolean
  pinFns?: string[]
}

/** Catalog sensor/display/comms modules: placed as their own header socket and wired by pin name. */
const MODULES: { re: RegExp; dev: Device }[] = [
  { re: /bme ?280|weather|humidity|barometr|altitude/, dev: { ids: ['bme280', 'bmp280', 'sht31'], label: 'ENV', purpose: 'temperature / humidity / pressure sensor (I2C)' } },
  { re: /temperature|thermomet|thermostat/, dev: { ids: ['sht31', 'ds18b20', 'dht22', 'bme280'], label: 'TEMP', purpose: 'temperature sensor' } },
  { re: /\bimu\b|acceler|gyro|mpu-?6050|orientation|tilt|balanc|9-?dof|6-?dof/, dev: { ids: ['mpu6050', 'gy521-mpu6050', 'icm20948', 'bno055'], label: 'IMU', purpose: '6-axis IMU (I2C)' } },
  { re: /ultrasonic|sonar|hc-?sr04|obstacle/, dev: { ids: ['hcsr04', 'vl53l0x'], label: 'SONAR', purpose: 'ultrasonic distance sensor', rail: '5V' } },
  { re: /lidar|\btof\b|time.of.flight|laser distance/, dev: { ids: ['vl53l0x'], label: 'TOF', purpose: 'time-of-flight distance sensor (I2C)' } },
  { re: /\bpir\b|presence|occupancy|motion sens/, dev: { ids: ['hcsr501'], label: 'PIR', purpose: 'PIR motion sensor', rail: '5V' } },
  { re: /current sens|power monitor|ina219|energy meter/, dev: { ids: ['ina219'], label: 'INA', purpose: 'current / power monitor (I2C)' } },
  { re: /heart|pulse|spo2|oximet/, dev: { ids: ['max30102'], label: 'PPG', purpose: 'pulse oximeter / heart-rate sensor (I2C)' } },
  { re: /colou?r sens/, dev: { ids: ['tcs34725'], label: 'RGB', purpose: 'colour sensor (I2C)' } },
  { re: /\bgps\b|gnss|location track/, dev: { ids: ['neo6m'], label: 'GPS', purpose: 'GPS receiver (UART)' } },
  { re: /e-?ink|e-?paper/, dev: { ids: ['epaper-29'], label: 'EPD', purpose: '2.9" e-paper display (SPI)' } },
  { re: /\btft\b|\blcd\b|colou?r (display|screen)|touchscreen/, dev: { ids: ['st7789-20', 'st7789-154', 'ili9341-28'], label: 'TFT', purpose: 'colour TFT display (SPI)' } },
  { re: /oled|display|screen|readout/, dev: { ids: ['ssd1306-096', 'sh1106-13'], label: 'OLED', purpose: '0.96" OLED display (I2C)' } },
  { re: /led matrix|8x8/, dev: { ids: ['max7219-8x8'], label: 'MATRIX', purpose: '8×8 LED matrix (SPI)', rail: '5V' } },
  { re: /nrf24|2\.4 ?ghz radio/, dev: { ids: ['nrf24l01'], label: 'NRF', purpose: 'nRF24L01 2.4 GHz radio (SPI)' } },
  { re: /hc-?05|classic bluetooth|bluetooth serial/, dev: { ids: ['hc05'], label: 'BT', purpose: 'HC-05 Bluetooth serial module (UART)', rail: '5V' } },
  { re: /ethernet|\blan\b|rj45/, dev: { ids: ['w5500'], label: 'ETH', purpose: 'W5500 Ethernet module (SPI)' } },
  { re: /can ?bus|\bcan\b/, dev: { ids: ['mcp2515'], label: 'CAN', purpose: 'MCP2515 CAN controller (SPI)', rail: '5V' } },
  { re: /sd ?card|micro ?sd|data ?log|logging|logger/, dev: { ids: ['microsd-module'], label: 'SD', purpose: 'microSD card socket (SPI)' } },
  { re: /speaker|audio out|amplifier|music|sound output/, dev: { ids: ['max98357a'], label: 'AMP', purpose: 'I2S class-D amplifier', rail: '5V' } },
  { re: /microphone|\bmic\b|voice|sound sens/, dev: { ids: ['inmp441'], label: 'MIC', purpose: 'I2S MEMS microphone' } },
  { re: /buzzer|beep|alarm|chime/, dev: { ids: ['buzzer-active', 'buzzer-passive'], label: 'BUZZER', purpose: 'buzzer', pinFns: ['SIG', 'GND'] } },
  { re: /rotary|encoder|knob/, dev: { ids: ['ec11'], label: 'ENC', purpose: 'rotary encoder with push switch' } },
  { re: /joystick|gamepad|controller/, dev: { ids: ['joystick-ky023'], label: 'JOY', purpose: 'analog joystick', adc: true } },
  { re: /keypad|keyboard|pin pad/, dev: { ids: ['keypad-4x4'], label: 'KEY', purpose: '4×4 keypad connector' } },
  { re: /touch (button|sens|pad)|capacitive/, dev: { ids: ['ttp223'], label: 'TOUCH', purpose: 'capacitive touch sensor' } },
  { re: /relay|mains|appliance/, dev: { ids: ['relay-1ch'], label: 'RELAY', purpose: '1-channel relay module', rail: '5V' } },
]

/** Off-board analog sensors with no catalog module: a 3-pin connector (VCC, GND, SIG) each. */
const ANALOG: { re: RegExp; noun: string; label: string; purpose: string; plural: number }[] = [
  { re: /\bemg\b|muscle|myo|electromyo/, noun: '(?:emg|muscle|myo)', label: 'EMG', purpose: 'EMG muscle sensor front-end (MyoWare/AD8232 style) input', plural: 3 },
  { re: /\becg\b|\bekg\b|electrocardio/, noun: '(?:ecg|ekg)', label: 'ECG', purpose: 'ECG front-end (AD8232) input', plural: 1 },
  { re: /soil|moisture/, noun: '(?:soil|moisture)', label: 'SOIL', purpose: 'capacitive soil-moisture probe', plural: 2 },
  { re: /\blight sens|\bldr\b|photo ?resist|ambient light|lux/, noun: '(?:light|ldr)', label: 'LIGHT', purpose: 'light sensor (LDR / analog)', plural: 1 },
  { re: /\bflex\b|bend sens/, noun: 'flex', label: 'FLEX', purpose: 'flex sensor', plural: 5 },
  { re: /\bforce\b|\bfsr\b|pressure pad|weight/, noun: '(?:force|fsr)', label: 'FSR', purpose: 'force-sensitive resistor', plural: 2 },
  { re: /\bgas\b|\bmq-?\d|smoke|air quality|co2/, noun: '(?:gas|mq|smoke)', label: 'GAS', purpose: 'MQ-series gas sensor', plural: 1 },
  { re: /potentiometer|\bpot\b|slider|fader/, noun: '(?:potentiometer|pot|slider|fader)', label: 'POT', purpose: 'potentiometer input', plural: 2 },
  { re: /water level|rain sens|leak/, noun: '(?:water|rain|leak)', label: 'WATER', purpose: 'water level / rain sensor', plural: 1 },
  { re: /analog sens|sensor input/, noun: 'sensor', label: 'AIN', purpose: 'analog sensor input', plural: 2 },
]

/** Switched loads: low-side MOSFET + flyback diode + 2-pin terminal. */
const LOADS: { re: RegExp; label: string; purpose: string }[] = [
  { re: /pump|watering|irrigat/, label: 'PUMP', purpose: 'water pump' },
  { re: /valve|solenoid/, label: 'VALVE', purpose: 'solenoid valve' },
  { re: /\bfan\b|cooling|ventilat/, label: 'FAN', purpose: 'fan' },
  { re: /heater|heating|incubat/, label: 'HEAT', purpose: 'heater' },
  { re: /vibration|haptic|vibro/, label: 'VIB', purpose: 'vibration motor (haptic feedback)' },
  { re: /\block\b|door strike/, label: 'LOCK', purpose: 'electric lock' },
]

class Planner {
  items: DigestItem[]
  byId: Map<string, DigestItem>
  intents: Intent[] = []
  used = new Set<string>()
  counters = new Map<string, number>()
  warnings: string[] = []
  edgeCycle = 0

  constructor(items: DigestItem[]) {
    this.items = items
    this.byId = new Map(items.map((i) => [i.id, i]))
  }

  find(cands: (string | RegExp)[], filter?: (i: DigestItem) => boolean): DigestItem | undefined {
    const ok = (i: DigestItem) => !filter || filter(i)
    for (const c of cands) {
      if (typeof c === 'string') {
        const it = this.byId.get(c)
        if (it && ok(it)) return it
      } else {
        const it = this.items.find((i) => ok(i) && (c.test(i.id) || c.test(i.name)))
        if (it) return it
      }
    }
    return undefined
  }

  ref(prefix: string) {
    const n = (this.counters.get(prefix) ?? 0) + 1
    this.counters.set(prefix, n)
    return `${prefix}${n}`
  }

  nextEdge(): 'back' | 'right' | 'left' {
    const e = (['back', 'right', 'back', 'left'] as const)[this.edgeCycle++ % 4]
    return e
  }

  add(prefix: string, item: DigestItem | undefined, i: Omit<Intent, 'ref' | 'catalogId'>): string | undefined {
    if (!item) return undefined
    const ref = this.ref(prefix)
    this.intents.push({ ...i, ref, catalogId: item.id })
    return ref
  }

  // common parts
  cap100n = () => this.find(['c-0603-100n', 'mlcc-100n-0805', 'c-0805-100n', /100n/], (i) => i.pads === 2)
  cap10u = () => this.find(['c-0805-10u', 'mlcc-10u-0805', 'c-0603-10u', /\b10u|10 ?µf/i], (i) => i.pads === 2 && !/ecap/.test(i.id)) ?? this.cap100n()
  cap1u = () => this.find(['c-0603-1u', 'c-0805-1u'], (i) => i.pads === 2) ?? this.cap100n()
  bulk = () => this.find(['ecap-220u-25', 'ecap-220u-25v', 'ecap-470u-16', 'ecap-100u-16', /ecap/]) ?? this.cap10u()
  res = (v: '10k' | '1k' | '4.7k' | '5.1k' | '330') => {
    const table: Record<string, (string | RegExp)[]> = {
      '10k': ['r-0603-10k', 'res-10k-0603', 'r-0805-10k', /10k/i],
      '1k': ['r-0603-1k', 'res-1k-0603', 'r-0805-1k', /(^|-)1k/i],
      '4.7k': ['r-0603-4.7k', 'res-4k7-0603', /4\.?7k|4k7/i],
      '5.1k': ['res-5k1-0603', /5\.1k|5k1/i, 'r-0603-4.7k', 'res-4k7-0603'],
      '330': ['r-0603-330', 'r-0603-220', 'r-0603-470', /330|220|470/, 'r-0603-1k', 'res-1k-0603'],
    }
    return this.find(table[v], (i) => i.pads === 2) ?? this.find(['res-10k-0603', 'r-0603-10k'])
  }
  header = (n: number) =>
    this.find([`jst-ph-${n}`, `jst-xh-${n}`, `header-1x${n}`, `terminal-${n}p-5.08`], (i) => i.pads === n) ??
    this.find([/header|jst|terminal|screw/i], (i) => i.pads === n)
  screw = (n: 2 | 3) => this.find([`screw-508-${n}`, `terminal-${n}p-5.08`], (i) => i.pads === n) ?? this.header(n)
  diode = () => this.find(['ss34', '1n5819', '1n4148w', /schottky|diode/i], (i) => i.pads === 2)

  decouple(near: string, rail: string, big = false) {
    this.add('C', this.cap100n(), { role: 'decoupling', dev: 'fixed', near, purpose: `100 nF decoupling for ${near} (${rail})`, nets: { 1: rail, 2: 'GND' } })
    if (big) this.add('C', this.cap10u(), { role: 'decoupling', dev: 'fixed', near, purpose: `10 µF bulk for ${near} (${rail})`, nets: { 1: rail, 2: 'GND' } })
  }

  run(request: string) {
    const q = ` ${request.toLowerCase()} `
    const devices: string[] = []

    // ---- power architecture
    const battery = /batter|wristband|wearable|portable|lipo|li-?ion|18650|cordless|handheld|watch|wireless remote|solar/.test(q)
    const usbRail = battery ? 'VBUS' : '+5V'
    const inRail = battery ? 'VSYS' : '+5V'

    // ---- MCU
    const mcuItem =
      this.find(['esp32-wroom-32e', /esp32.?wroom/i]) ??
      this.find(['esp32-s3-wroom-1', 'esp32-c3-mini-1']) ??
      this.items.find((i) => /mcu|module/i.test(i.category) && i.pads >= 20) ??
      this.items.find((i) => /board/i.test(i.category))
    const mcu = this.add('U', mcuItem, { role: 'mcu', dev: 'mcu', inRail, purpose: 'ESP32 controller: Wi-Fi + BLE, runs the firmware' })
    if (mcu) this.decouple(mcu, '+3V3', true)

    // ---- power entry: USB-C
    const usb = this.add('J', this.find(['usbc-16p', 'usb-c-16p', /usb.?c/i]), {
      role: 'connector',
      dev: 'usb',
      edge: 'front',
      rail: usbRail,
      purpose: 'USB-C 5 V power input',
    })
    if (usb) {
      const rr = this.res('5.1k')
      this.add('R', rr, { role: 'passive', dev: 'fixed', near: usb, purpose: 'USB-C CC1 pull-down (sink)', nets: { 1: 'CC1', 2: 'GND' } })
      this.add('R', rr, { role: 'passive', dev: 'fixed', near: usb, purpose: 'USB-C CC2 pull-down (sink)', nets: { 1: 'CC2', 2: 'GND' } })
    }

    // ---- battery with charger and diode OR-ing
    if (battery) {
      const charger = this.find(['tp4056'])
      const batJ = this.add('J', this.find(['lipo-jst-ph-2', 'jst-ph-2', /jst/i], (i) => i.pads === 2) ?? this.screw(2), {
        role: 'connector',
        dev: 'fixed',
        edge: 'left',
        purpose: 'Li-ion / LiPo battery connector',
        nets: { 1: 'VBAT', 2: charger ? 'BAT_N' : 'GND' },
      })
      let batOut = 'VBAT'
      if (charger && batJ) {
        this.add('U', charger, {
          role: 'power',
          dev: 'fixed',
          edge: 'left',
          purpose: 'TP4056 Li-ion charger with protection (charges from USB)',
          nets: { 1: usbRail, 2: 'GND', 3: 'VBAT', 4: 'BAT_N', 5: 'VBAT_OUT', 6: 'GND' },
        })
        batOut = 'VBAT_OUT'
      }
      const d = this.diode()
      const d1 = this.add('D', d, { role: 'power', dev: 'fixed', purpose: 'Schottky OR-ing: USB to system rail', nets: { 1: usbRail, 2: inRail } })
      this.add('D', d, { role: 'power', dev: 'fixed', near: d1, purpose: 'Schottky OR-ing: battery to system rail', nets: { 1: batOut, 2: inRail } })
    }

    // ---- 3V3 regulator
    const reg = this.add('U', this.find(['ams1117-33', 'ams1117-3.3', /ams1117|ldo|regulator/i], (i) => /power/i.test(i.category) || /1117/.test(i.id)), {
      role: 'power',
      dev: 'reg',
      inRail,
      purpose: `3.3 V LDO regulator (${inRail} → +3V3)`,
    })
    if (reg) {
      this.add('C', this.cap10u(), { role: 'decoupling', dev: 'fixed', near: reg, purpose: `regulator input cap (${inRail})`, nets: { 1: inRail, 2: 'GND' } })
      this.add('C', this.cap10u(), { role: 'decoupling', dev: 'fixed', near: reg, purpose: 'regulator output cap (+3V3)', nets: { 1: '+3V3', 2: 'GND' } })
    }

    // ---- MCU support: reset, boot, UART, status LED
    if (mcu) {
      this.add('R', this.res('10k'), { role: 'passive', dev: 'fixed', near: mcu, purpose: 'EN pull-up', nets: { 1: '+3V3', 2: 'EN' } })
      this.add('C', this.cap1u(), { role: 'passive', dev: 'fixed', near: mcu, purpose: 'EN reset delay cap', nets: { 1: 'EN', 2: 'GND' } })
      const tact = this.find(['tact-6mm', 'tact-6x6', /tact/i], (i) => i.pads === 4)
      this.add('SW', tact, { role: 'switch', dev: 'fixed', purpose: 'RESET button (EN to GND)', nets: { 1: 'EN', 2: 'GND' } })
      this.add('SW', tact, { role: 'switch', dev: 'fixed', purpose: 'BOOT button (IO0 to GND)', nets: { 1: 'BOOT', 2: 'GND' } })
      this.add('J', this.header(4), { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: 'UART programming header (GND TX RX 3V3)', nets: { 1: 'GND', 2: 'U0TX', 3: 'U0RX', 4: '+3V3' } })
      const led = this.add('D', this.find(['led-0603-green', 'led-0603', 'led-0603-blue', /led/i], (i) => i.pads === 2 && /indicator|led/i.test(i.category)), {
        role: 'indicator',
        dev: 'fixed',
        purpose: 'status LED',
        nets: { 1: 'LED_STATUS', 2: 'GND' },
      })
      if (led) this.add('R', this.res('1k'), { role: 'passive', dev: 'fixed', near: led, purpose: 'status LED current limit', nets: { 1: '@GPIO:STATUS_LED', 2: 'LED_STATUS' } })
    }

    // ---- catalog modules (sensors, displays, comms, ...)
    let i2c = false
    const taken = new Set<string>()
    for (const { re, dev } of MODULES) {
      if (!re.test(q)) continue
      const item = this.find(dev.ids.filter((x) => typeof x !== 'string' || !taken.has(x)))
      if (!item || taken.has(item.id)) continue
      taken.add(item.id)
      const n = /servo/.test(dev.label) ? 1 : 1
      for (let k = 0; k < n; k++) {
        const r = this.add('J', item, {
          role: 'connector',
          dev: 'device',
          edge: this.nextEdge(),
          rail: dev.rail === '5V' ? inRail : '+3V3',
          label: dev.label,
          adc: dev.adc,
          pinFns: dev.pinFns,
          purpose: `${dev.purpose} — ${item.name}`,
        })
        if (r) devices.push(item.name)
      }
      if (item.interfaces.includes('i2c')) i2c = true
    }

    // ---- servos
    if (/servo/.test(q)) {
      const n = countOf(q, 'servo', /servos/.test(q) ? 2 : 1)
      const item = this.find(['sg90']) ?? this.header(3)
      for (let k = 1; k <= n; k++) {
        const r = this.add('J', item, {
          role: 'connector',
          dev: item?.id === 'sg90' ? 'device' : 'fixed',
          edge: this.nextEdge(),
          rail: inRail,
          label: `SERVO${k}`,
          purpose: `servo ${k} connector (PWM, 5 V)`,
          nets: item?.id === 'sg90' ? undefined : { 1: `@GPIO:SERVO${k}_PWM`, 2: inRail, 3: 'GND' },
        })
        if (r && k === 1) devices.push(`${n} servo(s)`)
      }
      this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', purpose: `servo supply bulk cap (${inRail})`, nets: { 1: inRail, 2: 'GND' } })
    }

    // ---- steppers
    if (/stepper|3d print|cnc|plotter/.test(q)) {
      const n = countOf(q, 'stepper', /steppers|cnc|plotter|3d print/.test(q) ? 2 : 1)
      const drv = this.find(['a4988', 'drv8825', 'tmc2209'])
      for (let k = 1; k <= n && drv; k++) {
        const r = this.add('U', drv, { role: 'ic', dev: 'stepdrv', label: `STEP${k}`, rail: inRail, purpose: `stepper driver ${k} (${drv.name})` })
        if (!r) continue
        this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', near: r, purpose: `stepper ${k} motor supply bulk`, nets: { 1: inRail, 2: 'GND' } })
        this.add('J', this.header(4) ?? this.screw(2), {
          role: 'connector',
          dev: 'fixed',
          edge: this.nextEdge(),
          purpose: `stepper motor ${k} coils (1A 1B 2A 2B)`,
          nets: { 1: `STEP${k}_1A`, 2: `STEP${k}_1B`, 3: `STEP${k}_2A`, 4: `STEP${k}_2B` },
        })
      }
      if (drv) devices.push(`${n} stepper(s)`)
    }

    // ---- DC motors: TB6612FNG dual H-bridges + screw terminals
    const wantsMotors = /\bmotor|wheel|rover|robot|\bcar\b|4wd|2wd|\bdrive\b|tank|mecanum|propel|vehicle/.test(q) && !/\bstepper motor|servo motor/.test(q)
    if (wantsMotors) {
      const n = /4wd|four.?wheel|4 ?motors|four motors|mecanum|quad/.test(q) ? 4 : countOf(q, 'motor', 2)
      const drvItem = this.find(['tb6612fng', /tb6612/i, 'drv8833'])
      if (drvItem) {
        const motors: string[] = []
        for (let k = 1; k <= n; k++) motors.push(`M${k}`)
        for (let d = 0; d < Math.ceil(n / 2); d++) {
          const a = motors[2 * d]
          const b = motors[2 * d + 1] ?? `M${n + 1}`
          const drv = this.add('U', drvItem, {
            role: 'ic',
            dev: 'tb6612',
            motors: [a, b],
            rail: inRail,
            purpose: `dual H-bridge for motors ${a}${motors[2 * d + 1] ? `/${b}` : ''}`,
          })
          if (!drv) continue
          this.decouple(drv, '+3V3')
          this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', near: drv, purpose: `motor supply bulk cap (${inRail})`, nets: { 1: inRail, 2: 'GND' } })
        }
        const sides: ('left' | 'right')[] = ['left', 'right']
        for (let k = 0; k < n; k++) {
          this.add('J', this.screw(2), { role: 'connector', dev: 'fixed', edge: sides[k % 2], purpose: `motor ${motors[k]} terminal`, nets: { 1: `${motors[k]}+`, 2: `${motors[k]}-` } })
        }
        devices.push(`${n} DC motors`)
      }
    }

    // ---- addressable LED strip
    if (/led strip|neopixel|ws2812|addressable|rgb strip|light strip/.test(q)) {
      const j = this.add('J', this.screw(3), { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: 'WS2812B LED strip connector (5V DIN GND)', nets: { 1: inRail, 2: 'STRIP_DIN', 3: 'GND' } })
      if (j) {
        this.add('R', this.res('330'), { role: 'passive', dev: 'fixed', near: j, purpose: 'LED strip data series resistor', nets: { 1: '@GPIO:STRIP_DATA', 2: 'STRIP_DIN' } })
        this.add('C', this.bulk(), { role: 'decoupling', dev: 'fixed', near: j, purpose: 'LED strip supply bulk cap', nets: { 1: inRail, 2: 'GND' } })
        devices.push('LED strip')
      }
    }

    // ---- switched loads
    for (const l of LOADS) {
      if (!l.re.test(q)) continue
      const fet = this.find(['ao3400', 'irlz44n', '2n7002', /mosfet/i], (i) => i.pads >= 3)
      if (!fet) break
      const sw = `${l.label}_SW`
      const isIrlz = fet.id === 'irlz44n'
      const qref = this.add('Q', fet, {
        role: 'ic',
        dev: 'fixed',
        purpose: `low-side MOSFET switch for the ${l.purpose}`,
        nets: isIrlz ? { 1: `@GPIO:${l.label}_EN`, 2: sw, 3: 'GND' } : { 1: `@GPIO:${l.label}_EN`, 2: 'GND', 3: sw },
      })
      if (!qref) continue
      this.add('D', this.diode(), { role: 'passive', dev: 'fixed', near: qref, purpose: `flyback diode across the ${l.purpose}`, nets: { 1: sw, 2: inRail } })
      this.add('J', this.screw(2), { role: 'connector', dev: 'fixed', edge: this.nextEdge(), purpose: `${l.purpose} terminal (+ / switched −)`, nets: { 1: inRail, 2: sw } })
      devices.push(l.purpose)
    }

    // ---- off-board analog sensors
    let adcLeft = 6
    for (const a of ANALOG) {
      if (!a.re.test(q) || adcLeft <= 0) continue
      const plural = new RegExp(`${a.noun}\\w*\\s+(?:\\w+\\s+)?(sensors|probes|channels|inputs|electrodes)|sensors`).test(q)
      const n = Math.min(countOf(q, a.noun, plural ? a.plural : 1), adcLeft)
      adcLeft -= n
      const conn = this.header(3)
      for (let k = 1; k <= n; k++) {
        this.add('J', conn, {
          role: 'connector',
          dev: 'fixed',
          edge: this.nextEdge(),
          purpose: `${a.purpose}${n > 1 ? ` ${k}` : ''} (VCC GND SIG)`,
          nets: { 1: '+3V3', 2: 'GND', 3: `@ADC:${a.label}${n > 1 ? k : ''}` },
        })
      }
      devices.push(`${n}× ${a.label.toLowerCase()} input`)
    }

    // ---- I2C pull-ups
    if (i2c && mcu) {
      const r = this.res('4.7k')
      this.add('R', r, { role: 'passive', dev: 'fixed', near: mcu, purpose: 'I2C SDA pull-up', nets: { 1: '+3V3', 2: 'SDA' } })
      this.add('R', r, { role: 'passive', dev: 'fixed', near: mcu, purpose: 'I2C SCL pull-up', nets: { 1: '+3V3', 2: 'SCL' } })
    }

    // ---- nothing specific recognised: GPIO breakout so the board is still useful
    if (!devices.length) {
      const h = this.header(8) ?? this.header(6)
      if (h) {
        const nets: Record<number, Tok> = { 1: '+3V3', 2: 'GND' }
        for (let k = 3; k <= h.pads; k++) nets[k] = `@GPIO:GPIO_${k - 2}`
        this.add('J', h, { role: 'connector', dev: 'fixed', edge: 'back', purpose: 'GPIO breakout header (3V3 GND + GPIO)', nets })
      }
    }

    return { devices, battery, inRail }
  }
}

function boardName(request: string): string {
  const head = request.split(/\b(?:with|for|that|using|which|featuring)\b|[,.;:]/i)[0]
  const words = head
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^(a|an|the|make|build|design|create|me|i|want|need|please|simple|small)$/i.test(w))
    .slice(0, 4)
  if (!words.length) return 'ESP32 Dev Board'
  const title = words.map((w) => (w.length <= 3 && /^[a-z0-9]+$/i.test(w) && !/^(and|of|to)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ')
  return /board|controller|station|module|hub/i.test(title) ? title : `${title} Board`
}

// ---------------------------------------------------------------- netlist

function pinNamesFor(p: BlockPart, intent: Intent | undefined): string[] {
  if (intent?.pinFns) return intent.pinFns
  if (p.names && p.names.length >= p.pins) return p.names.map(norm)
  const n = p.pins
  const nm = p.name.toUpperCase()
  const pad = (a: string[]) => Array.from({ length: n }, (_, i) => a[i] ?? 'NC')
  switch (p.kind) {
    case 'module':
      return pad(ESP32_PINS)
    case 'ssop':
      return pad(TB6612_PINS)
    case 'soic':
      return /CH34/.test(nm) ? pad(CH340_PINS) : pad([])
    case 'usbc':
      return pad(USBC_PINS)
    case 'sot223':
      return /1117|LDO|REG|78|LM|AP2|XC6|MCP17/.test(nm) ? pad(['GND', 'VOUT', 'VIN', 'VOUT']) : pad(['G', 'S', 'D', 'D'])
    case 'led':
      return pad(['A', 'K'])
    case 'ecap':
      return pad(['+', '-'])
    default:
      return Array.from({ length: n }, (_, i) => String(i + 1))
  }
}

const GND_RE = /^(GND\d*|P?GND\d*|AGND|DGND|VSS|0V|-|IN-|OUT-|SLEEVE|SHIELD|SHELL)$/
const SUPPLY_RE = /^(VCC|VDD|VIN|VDDIO|VIO|3V3|3\.3V?|\+3V3|5V|\+5V|VBAT|PWR|V\+|\+)$/
const IGNORE_RE = /^(NC|XDA|XCL|AD0|ADDR|CSB|ALRT|GAIN|L\/R|SW2|VO|RW|T_CS|ANT|SBU\d|D[NP]\d|UD[+-]|NC\d*|IP[+-]|VIN[+-]|COM|NO|PPS|STATE|RING|FAULT|DIAG|MS\d|M\d|SLP|PROGRAM)$/

function deviceToken(name: string, it: Intent | undefined, ref: string, spiDev: boolean): Tok {
  const n = norm(name)
  if (!n || /^\d+$/.test(n)) return null
  if (GND_RE.test(n)) return 'GND'
  if (SUPPLY_RE.test(n)) return it?.rail ?? '+3V3'
  if (/^(BLK|LED|BL|A)$/.test(n) && spiDev) return it?.rail ?? '+3V3'
  if (n === 'SDA') return spiDev ? 'SPI_MOSI' : 'SDA'
  if (n === 'SCL') return spiDev ? 'SPI_SCK' : 'SCL'
  if (/^(SCK|SCLK|CLK)$/.test(n)) return 'SPI_SCK'
  if (/^(MOSI|MO|SI|SDI|DI)$/.test(n) || (n === 'DIN' && spiDev)) return 'SPI_MOSI'
  if (/^(MISO|MI|SO|DO)$/.test(n) || (n === 'SDO' && spiDev)) return 'SPI_MISO'
  if (n === 'SDO') return 'GND'
  if (IGNORE_RE.test(n)) return null
  if (!it) return null // unknown part: only power / bus pins are certain
  const label = it.label ?? ref
  const analog = it.adc || /^(A\d|AOUT|AO|SIG|VRX|VRY|S\d|OUT)$/.test(n)
  return `${analog && it.adc !== false && (it.adc || /^(A\d|AOUT|AO|VRX|VRY)$/.test(n)) ? '@ADC' : '@GPIO'}:${netName(`${label}_${n}`)}`
}

function mcuToken(n: string, it: Intent | undefined, flags: { i2c: boolean; spi: boolean }): Tok {
  if (GND_RE.test(n)) return 'GND'
  if (/^(3V3|3\.3V?|\+3V3|VDD)$/.test(n)) return '+3V3'
  if (/^(5V|VIN|VBUS|VSYS|RAW|USB)$/.test(n)) return it?.inRail ?? '+5V'
  if (n === 'EN' || n === 'RST' || n === 'RUN') return 'EN'
  if (/^(TXD0|TX|TXD|U0TXD|GPIO43)$/.test(n)) return 'U0TX'
  if (/^(RXD0|RX|RXD|U0RXD|GPIO44)$/.test(n)) return 'U0RX'
  if (/^(IO0|GPIO0|BOOT0?)$/.test(n)) return 'BOOT'
  if (flags.i2c && /^(IO21|SDA)$/.test(n)) return 'SDA'
  if (flags.i2c && /^(IO22|SCL)$/.test(n)) return 'SCL'
  if (flags.spi && /^(IO18|SCK)$/.test(n)) return 'SPI_SCK'
  if (flags.spi && /^(IO23|MOSI|MO)$/.test(n)) return 'SPI_MOSI'
  if (flags.spi && /^(IO19|MISO|MI)$/.test(n)) return 'SPI_MISO'
  return null
}

function tb6612Token(n: string, it: Intent): Tok {
  const [a, b] = it.motors ?? ['MA', 'MB']
  if (GND_RE.test(n) || /^PGND\d$/.test(n)) return 'GND'
  if (/^VM\d?$/.test(n)) return it.rail ?? '+5V'
  if (n === 'VCC' || n === 'STBY') return '+3V3'
  if (n === 'AO1') return `${a}+`
  if (n === 'AO2') return `${a}-`
  if (n === 'BO1') return `${b}+`
  if (n === 'BO2') return `${b}-`
  const m = /^(A|B)IN(\d)$/.exec(n)
  if (m) return `@GPIO:${m[1] === 'A' ? a : b}_IN${m[2]}`
  if (n === 'PWMA') return `@GPIO:${a}_PWM`
  if (n === 'PWMB') return `@GPIO:${b}_PWM`
  return null
}

function stepToken(n: string, it: Intent): Tok {
  const l = it.label ?? 'STEP'
  if (GND_RE.test(n)) return 'GND'
  if (/^(VMOT|VM)$/.test(n)) return it.rail ?? '+5V'
  if (/^(VDD|VIO)$/.test(n)) return '+3V3'
  if (/^[12][AB]$/.test(n)) return `${l}_${n}`
  if (n === 'STEP' || n === 'DIR' || n === 'EN') return `@GPIO:${l}_${n}`
  return null
}

export function buildNets(parts: BlockPart[], intents: Map<string, Intent>): { name: string; pins: string[] }[] {
  // pass 1: tokens
  const toks: { pin: string; tok: Tok; mcu: boolean }[] = []
  const mcuPart = parts.find((p) => intents.get(p.ref)?.dev === 'mcu') ?? parts.find((p) => p.kind === 'module')
  const flags = { i2c: false, spi: false }
  const names = new Map(parts.map((p) => [p.ref, pinNamesFor(p, intents.get(p.ref))]))

  for (const p of parts) {
    if (p === mcuPart) continue
    const it = intents.get(p.ref)
    const nm = names.get(p.ref)!
    const spiDev = nm.some((x) => /^(CS|DC|CSN|NSS|SCSN|MOSI|DIN)$/.test(norm(x))) && !nm.some((x) => norm(x) === 'SDA' && !nm.some((y) => /^(DC|CS)$/.test(norm(y))))
    for (let i = 0; i < p.pins; i++) {
      let tok: Tok = null
      if (it?.nets) tok = it.nets[i + 1] ?? null
      else if (it?.dev === 'reg' || (!it && p.kind === 'sot223' && nm[0] === 'GND')) {
        const n = nm[i]
        tok = n === 'GND' ? 'GND' : /^VOUT/.test(n) ? '+3V3' : n === 'VIN' ? (it?.inRail ?? '+5V') : null
      } else if (it?.dev === 'usb' || (!it && p.kind === 'usbc')) {
        const n = nm[i]
        tok = n === 'VBUS' ? (it?.rail ?? '+5V') : GND_RE.test(n) ? 'GND' : /^CC[12]$/.test(n) ? n : null
      } else if (it?.dev === 'tb6612') tok = tb6612Token(nm[i], it)
      else if (it?.dev === 'stepdrv') tok = stepToken(norm(nm[i]), it)
      else tok = deviceToken(nm[i], it, p.ref, spiDev)
      if (!tok) continue
      if (tok === 'SDA' || tok === 'SCL') flags.i2c = true
      if (tok.startsWith('SPI_')) flags.spi = true
      toks.push({ pin: `${p.ref}.${i + 1}`, tok, mcu: false })
    }
  }

  // MCU fixed pins + GPIO pool
  const pool: string[] = []
  const adcPool: string[] = []
  const mcuPinOf = new Map<string, string>()
  if (mcuPart) {
    const it = intents.get(mcuPart.ref)
    const nm = names.get(mcuPart.ref)!.map(norm)
    nm.forEach((n, i) => {
      const pin = `${mcuPart.ref}.${i + 1}`
      const tok = mcuToken(n, it, flags)
      if (tok) toks.push({ pin, tok, mcu: true })
      else if (!mcuPinOf.has(n)) mcuPinOf.set(n, pin)
    })
    const esp = nm.includes('IO21')
    const ioOrder = esp ? IO_POOL : nm.filter((n) => /^(IO|GPIO|GP|D|P[A-D])\d+$/.test(n))
    const adcOrder = esp ? ADC_POOL : nm.filter((n) => /^(A|ADC)\d+$|^GP2[678]$/.test(n))
    for (const n of adcOrder) if (mcuPinOf.has(n)) adcPool.push(n)
    for (const n of ioOrder) if (mcuPinOf.has(n) && !adcPool.slice(0, 4).includes(n)) pool.push(n)
  }

  // pass 2: assign
  const nets = new Map<string, string[]>()
  const owner = new Set<string>()
  const add = (net: string, pin: string) => {
    if (owner.has(pin)) return
    owner.add(pin)
    const name = netName(net)
    const list = nets.get(name) ?? []
    list.push(pin)
    nets.set(name, list)
  }
  const usedMcu = new Set<string>()
  const allocated = new Set<string>()
  const take = (from: string[]) => {
    const n = from.find((x) => !usedMcu.has(x))
    if (n) usedMcu.add(n)
    return n
  }
  for (const t of toks) {
    const m = /^@(GPIO|ADC):(.+)$/.exec(t.tok!)
    if (!m) {
      add(t.tok!, t.pin)
      continue
    }
    const net = m[2]
    if (!allocated.has(net)) {
      const n = m[1] === 'ADC' ? (take(adcPool) ?? take(pool)) : take(pool)
      if (!n) continue // out of GPIO: leave the pin unconnected
      allocated.add(net)
      add(net, mcuPinOf.get(n)!)
    }
    add(net, t.pin)
  }
  return [...nets].filter(([, pins]) => pins.length >= 2).map(([name, pins]) => ({ name, pins }))
}

// ---------------------------------------------------------------- entry

/** A deterministic LlmCall that plans and wires boards without any model. One instance per generation. */
export function offlineLlm(): LlmCall {
  const intents = new Map<string, Intent>()
  return async (o) => {
    const props = isRec(o.schema) && isRec(o.schema.properties) ? o.schema.properties : {}
    if ('replacements' in props) {
      // offline plans only use catalog ids; drop anything else
      const refs = [...o.prompt.matchAll(/^([A-Z]{1,3}\d{1,3}):/gm)].map((m) => m[1])
      return { replacements: refs.map((ref) => ({ ref, catalogId: 'DROP' })) }
    }
    if ('nets' in props || /schematic engine/i.test(o.system)) {
      return { nets: buildNets(parseBlock(o.prompt), intents) }
    }
    // plan
    const request = /^Request: (.*)$/m.exec(o.prompt)?.[1] ?? o.prompt
    const planner = new Planner(parseDigest(o.prompt))
    const { devices, battery, inRail } = planner.run(request)
    intents.clear()
    for (const it of planner.intents) intents.set(it.ref, it)
    return {
      name: boardName(request),
      summary: `Offline planner: ESP32-WROOM-32E controller${devices.length ? ` with ${devices.join(', ')}` : ' with a GPIO breakout'}; ${battery ? 'battery with USB charging and diode OR-ing' : 'USB-C 5 V'} feeding an AMS1117 3.3 V LDO.`,
      supply: battery ? `USB-C 5V / Li-ion -> ${inRail} -> 3.3V` : 'USB-C 5V -> 3.3V',
      parts: planner.intents.map((i) => ({ ref: i.ref, catalogId: i.catalogId, purpose: i.purpose, role: i.role, near: i.near ?? '', edge: i.edge ?? 'none' })),
    }
  }
}
