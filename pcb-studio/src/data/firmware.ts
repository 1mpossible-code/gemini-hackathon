// Arduino (C++) starter firmware for the board's microcontroller, written from the
// board's own netlist: every signal net that reaches an MCU pin becomes a named pin.
import { byId } from '@/data/catalog'
import type { Board, Part } from '@/data/board'

const POWER = /^(gnd|agnd|vss|vcc|vdd|vbus|vbat|vin|\+?\d+v\d*|\+.*|en|boot|reset|rst|cc\d|nc)$/i
const ident = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'N$1') || 'SIG'

/** GPIO number of an MCU pin from its catalog name or function, e.g. "33 IO21" or "GPIO3 / U0RXD". */
function gpioOf(name: string, fn: string): number | null {
  const m = /\bGPIO(\d+)\b/i.exec(fn) ?? /\b(?:IO|GPIO|GP|D|P)(\d+)\b/i.exec(name)
  return m ? Number(m[1]) : null
}

export function isController(part: Part): boolean {
  const item = part.catalogId ? byId[part.catalogId] : undefined
  if (!item) return false
  return item.pins.filter((p) => gpioOf(p.name, p.fn) !== null).length >= 6
}

interface Sig { name: string; gpio: number }

/** Package pin to GPIO for modules whose catalog entry lists only some pins. */
const PACKAGE_GPIO: Record<string, Record<number, number>> = {
  // ESP32-WROOM-32E datasheet, table 2 (pins 17-22 and 32 are not connected)
  'esp32-wroom-32': { 4: 36, 5: 39, 6: 34, 7: 35, 8: 32, 9: 33, 10: 25, 11: 26, 12: 27, 13: 14, 14: 12, 16: 13, 23: 15, 24: 2, 25: 0, 26: 4, 27: 16, 28: 17, 29: 5, 30: 18, 31: 19, 33: 21, 34: 3, 35: 1, 36: 22, 37: 23 },
}

function signals(board: Board, mcu: Part): { sigs: Sig[]; unknown: string[] } {
  const pins = byId[mcu.catalogId!].pins
  const table = Object.entries(PACKAGE_GPIO).find(([k]) => mcu.catalogId!.startsWith(k))?.[1]
  const unknown: string[] = []
  const out = new Map<string, Sig>()
  for (const net of board.nets) {
    if (POWER.test(net.name)) continue
    for (const ref of net.path) {
      const [r, n] = ref.split('.')
      if (r !== mcu.ref) continue
      // Catalog pin names lead with the package pin number ("33 IO21"). A pin that cannot
      // be resolved is reported, never guessed.
      const pin = pins.find((p) => p.name.split(' ')[0] === n)
      const gpio = (pin ? gpioOf(pin.name, pin.fn) : null) ?? table?.[Number(n)] ?? null
      if (gpio === null) unknown.push(`${net.name} on ${mcu.ref} pin ${n}`)
      else if (!out.has(net.name)) out.set(net.name, { name: net.name, gpio })
    }
  }
  return { sigs: [...out.values()].sort((a, b) => a.gpio - b.gpio), unknown: [...new Set(unknown)] }
}

const is = (s: Sig, re: RegExp) => re.test(s.name)

export function firmwareFor(board: Board, mcu: Part): string {
  const { sigs, unknown } = signals(board, mcu)
  const sda = sigs.find((s) => is(s, /^(i2c_)?sda/i))
  const scl = sigs.find((s) => is(s, /^(i2c_)?scl/i))
  const spi = { sck: sigs.find((s) => is(s, /sck|sclk|clk$/i)), mosi: sigs.find((s) => is(s, /mosi|sdi|din$/i)), miso: sigs.find((s) => is(s, /miso|sdo/i)) }
  const uart = sigs.filter((s) => is(s, /^u\d?(tx|rx)|^(tx|rx)d?\d?$/i))
  const bus = new Set([sda, scl, spi.sck, spi.mosi, spi.miso, ...uart].filter(Boolean) as Sig[])
  const rest = sigs.filter((s) => !bus.has(s))
  const analog = rest.filter((s) => is(s, /adc|ain|sense|emg|soil|moist|ntc|therm|vbat|batt|level|pot|ldr|gas|analog/i))
  const pwm = rest.filter((s) => !analog.includes(s) && is(s, /pwm|esc|servo|motor|fan|heater|pump|dim|haptic|vib/i))
  const inputs = rest.filter((s) => !analog.includes(s) && !pwm.includes(s) && is(s, /btn|button|user|sw\d*$|switch|key|int|irq|echo|pir|endstop|limit|detect|busy|dout/i))
  const outputs = rest.filter((s) => !analog.includes(s) && !pwm.includes(s) && !inputs.includes(s))
  const def = (s: Sig) => `PIN_${ident(s.name)}`
  const L: string[] = []
  L.push(`// ${board.name} · firmware for ${mcu.ref} (${mcu.name})`)
  L.push('// Pin map comes from this board\'s netlist. Change the board and this file follows.')
  L.push('#include <Arduino.h>')
  if (sda && scl) L.push('#include <Wire.h>')
  if (spi.sck && spi.mosi) L.push('#include <SPI.h>')
  L.push('')
  if (!sigs.length) L.push('// No signal nets reach this controller yet.')
  for (const s of sigs) L.push(`constexpr uint8_t ${def(s).padEnd(22)} = ${s.gpio};  // net ${s.name}`)
  for (const u of unknown) L.push(`// ${u}: GPIO number not in the catalog, set it by hand`)
  L.push('', 'void setup() {', '  Serial.begin(115200);')
  if (sda && scl) L.push(`  Wire.begin(${def(sda)}, ${def(scl)});`)
  if (spi.sck && spi.mosi) L.push(`  SPI.begin(${def(spi.sck)}, ${spi.miso ? def(spi.miso) : '-1'}, ${def(spi.mosi)});`)
  for (const s of inputs) L.push(`  pinMode(${def(s)}, INPUT_PULLUP);`)
  for (const s of [...outputs, ...pwm]) L.push(`  pinMode(${def(s)}, OUTPUT);`)
  for (const s of outputs) L.push(`  digitalWrite(${def(s)}, LOW);`)
  L.push('}', '', 'void loop() {')
  for (const s of analog) L.push(`  int ${ident(s.name).toLowerCase()} = analogRead(${def(s)});`)
  for (const s of inputs) L.push(`  bool ${ident(s.name).toLowerCase()} = digitalRead(${def(s)}) == LOW;`)
  for (const s of analog) L.push(`  Serial.printf("${s.name}=%d\\n", ${ident(s.name).toLowerCase()});`)
  for (const s of inputs) L.push(`  if (${ident(s.name).toLowerCase()}) Serial.println("${s.name} active");`)
  for (const s of pwm) L.push(`  analogWrite(${def(s)}, 0);  // 0..255 duty for ${s.name}`)
  const led = outputs.find((s) => is(s, /led/i))
  if (led) L.push(`  digitalWrite(${def(led)}, (millis() / 500) % 2);  // heartbeat`)
  L.push('  delay(20);', '}', '')
  return L.join('\n')
}
