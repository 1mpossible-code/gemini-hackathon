/** Smaller supported 2-layer ESP32 USB-UART Telemetry Node exercising all 15 Lean theorems,
 *  with one reproducible top-layer routing violation (VBUS crosses U0TXD). */
export function buildTelemetryDemoBoard(): import('./board').Board {
  return {
    name: 'ESP32 USB-UART Telemetry Node (Demo)',
    revision: 'A1',
    width: 66,
    height: 48,
    thickness: 1.6,
    cornerRadius: 2.5,
    holes: [
      { x: -29, y: -20, d: 3.2 },
      { x: 29, y: -20, d: 3.2 },
      { x: -29, y: 20, d: 3.2 },
      { x: 29, y: 20, d: 3.2 },
    ],
    parts: [
      {
        ref: 'U1', kind: 'module', name: 'ESP32-WROOM-32E', mpn: 'ESP32-WROOM-32E-N8', manufacturer: 'Espressif',
        description: 'Wi-Fi + Bluetooth LE module', pkg: 'SMD-38', x: -3, y: -3, rot: 0, category: 'RF module',
      },
      {
        ref: 'U4', kind: 'sot223', name: 'AMS1117-3.3', mpn: 'AMS1117-3.3', manufacturer: 'Advanced Monolithic Systems',
        description: '1 A LDO 3.3 V regulator', pkg: 'SOT-223', x: -20, y: -15, rot: 0, category: 'Power',
      },
      {
        ref: 'U5', kind: 'soic', name: 'CH340C', mpn: 'CH340C', manufacturer: 'WCH',
        description: 'USB to UART bridge', pkg: 'SOIC-16', x: 16, y: -5, rot: 0, category: 'Interface',
      },
      {
        ref: 'J1', kind: 'usbc', name: 'USB-C receptacle', mpn: 'TYPE-C-31-M-12', manufacturer: 'Korean Hroparts',
        description: '16-pin USB Type-C receptacle', pkg: 'USB-C-16P', x: 16, y: 20.6, rot: 0, category: 'Connector',
      },
      {
        ref: 'J6', kind: 'terminal', pins: 2, name: 'Power input', mpn: 'KF301-5.0-2P', manufacturer: 'Cixi Kefa',
        description: '2-position screw terminal, 6-12 V input', pkg: 'THT 2P 5.08', x: -27, y: -2, rot: 90, category: 'Connector',
      },
      {
        ref: 'J7', kind: 'header', pins: 6, name: 'I2C / GPIO header', mpn: 'PZ254V-11-06P', manufacturer: 'XFCN',
        description: '1x6 male pin header, 2.54 mm pitch', pkg: 'THT 1x6 2.54', x: -12, y: 17, rot: 90, category: 'Connector',
      },
      {
        ref: 'C9', kind: 'chip', size: '0805', name: '10uF MLCC', mpn: 'CL21A106KAQNNNE', manufacturer: 'Samsung',
        description: '10uF input cap', pkg: '0805', x: -24, y: -19, rot: 0, value: '10uF', category: 'Capacitor',
      },
      {
        ref: 'C10', kind: 'chip', size: '0805', name: '22uF MLCC', mpn: 'CL21A226KAQNNNE', manufacturer: 'Samsung',
        description: '22uF output cap', pkg: '0805', x: -14, y: -19, rot: 0, value: '22uF', category: 'Capacitor',
      },
      {
        ref: 'C11', kind: 'chip', size: '0805', name: '100nF MLCC', mpn: 'CL21A104KAQNNNE', manufacturer: 'Samsung',
        description: '100nF decoupling cap', pkg: '0805', x: 16, y: -15, rot: 0, value: '100nF', category: 'Capacitor',
      },
      {
        ref: 'R1', kind: 'chip', size: '0603', name: '1k resistor', mpn: 'RC0603FR-071kL', manufacturer: 'Yageo',
        description: '1k LED resistor', pkg: '0603', x: 25, y: -12, rot: 90, value: '1k', category: 'Resistor',
      },
      {
        ref: 'D1', kind: 'led', size: '0603', name: 'Status LED', mpn: '19-217/GHC-YR1S2/3T', manufacturer: 'Everlight',
        description: 'White 0603 indicator LED', pkg: '0603', x: 25, y: -16, rot: 0, category: 'LED',
      },
    ],
    nets: [
      { name: 'VIN', path: ['J6.1', 'C9.1', 'U4.3'], width: 1.0 },
      { name: '+3V3', path: ['U4.4', 'C10.1'], width: 0.8 },
      { name: '+3V3', path: ['C10.1', 'U1.2'], width: 0.8, via: [[-14, -12]] },
      { name: '+3V3', path: ['U5.16', 'C11.2'], width: 0.5 },
      { name: '+3V3', path: ['J7.1', 'U1.2'], width: 0.5, layer: 'bottom', via: [[-19, 10]] },
      { name: 'VBUS', path: ['J1.1', 'U5.1'], width: 0.6, layer: 'top', via: [[10, 14]] },
      { name: 'USB_D+', path: ['J1.6', 'U5.5'], width: 0.3, layer: 'bottom', via: [[15.75, 11], [11.5, 4], [11.5, -3.665]] },
      { name: 'USB_D-', path: ['J1.7', 'U5.6'], width: 0.3, layer: 'bottom', via: [[16.5, 11], [12.3, 4], [12.3, -3.095]] },
      // Reproducible routing violation: VBUS crosses U0TXD on top copper
      { name: 'U0TXD', path: ['U5.2', 'U1.36'], width: 0.35, layer: 'top' },
      { name: 'U0RXD', path: ['U5.3', 'U1.35'], width: 0.35, layer: 'bottom', via: [[9, -6]] },
      { name: 'SDA', path: ['U1.27', 'J7.3'], width: 0.3, layer: 'top', via: [[9, 10]] },
      { name: 'SCL', path: ['U1.28', 'J7.4'], width: 0.3, layer: 'bottom', via: [[7, 13]] },
      { name: 'LED1', path: ['U1.37', 'R1.1'], width: 0.3, layer: 'bottom', via: [[6, -15], [22, -15]] },
      { name: 'LED1', path: ['R1.2', 'D1.1'], width: 0.3, layer: 'top' },
    ],
    groundVias: [[-10, 0], [10, 0]],
  }
}

