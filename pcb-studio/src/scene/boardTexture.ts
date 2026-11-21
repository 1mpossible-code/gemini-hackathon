// Board surface artwork generated procedurally from our netlist, in the spirit of
// STC-B Board 3D Viewer's canvas textures (Apache-2.0),
// https://github.com/DeliciousBuding/stcb-board-3d-viewer
import * as THREE from 'three'
import type { Board } from '@/data/board'
import { bodyFor, padsFor, toBoard, type Trace } from '@/pcb/footprint'

export const PX_PER_MM = 28

export interface ArtworkOptions {
  traces: boolean
  silk: boolean
}

export interface BoardArtwork {
  color: THREE.CanvasTexture
  /** G = roughness, B = metalness */
  orm: THREE.CanvasTexture
  bump: THREE.CanvasTexture
  repaint(opts: ArtworkOptions): void
  dispose(): void
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function texture(canvas: HTMLCanvasElement, srgb: boolean) {
  const t = new THREE.CanvasTexture(canvas)
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  t.anisotropy = 16
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.magFilter = THREE.LinearFilter
  return t
}

/** Deterministic grain so the matte mask doesn't read as flat plastic. */
function grain(ctx: CanvasRenderingContext2D, w: number, h: number, base: number, amp: number) {
  const img = ctx.getImageData(0, 0, w, h)
  let s = 1234567
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const n = ((s >> 8) & 0xff) / 255 - 0.5
    const v = base + n * amp
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

export function createBoardArtwork(board: Board, traces: Trace[], opts: ArtworkOptions): BoardArtwork {
  const W = Math.round(board.width * PX_PER_MM)
  const H = Math.round(board.height * PX_PER_MM)
  const colorC = makeCanvas(W, H)
  const ormC = makeCanvas(W, H)
  const bumpC = makeCanvas(W, H)
  const color = texture(colorC, true)
  const orm = texture(ormC, false)
  const bump = texture(bumpC, false)

  // board mm -> canvas px (x right, y toward front = down the canvas)
  const px = (x: number) => (x + board.width / 2) * PX_PER_MM
  const py = (y: number) => (y + board.height / 2) * PX_PER_MM
  const mm = (v: number) => v * PX_PER_MM

  const pads = board.parts.flatMap((p) =>
    padsFor(p).map((pad) => {
      const [x, y] = toBoard(p, pad.x, pad.y)
      // pad rectangles rotate with the part; quarter turns swap w/h
      const quarter = Math.round(((p.rot % 180) + 180) % 180) === 90
      return { x, y, w: quarter ? pad.h : pad.w, h: quarter ? pad.w : pad.h, shape: pad.shape, drill: pad.drill }
    }),
  )
  const vias = [...board.groundVias, ...traces.flatMap((t) => t.vias)]

  function tracePath(ctx: CanvasRenderingContext2D, t: Trace) {
    ctx.beginPath()
    t.points.forEach(([x, y], i) => (i ? ctx.lineTo(px(x), py(y)) : ctx.moveTo(px(x), py(y))))
  }

  function padShape(ctx: CanvasRenderingContext2D, p: (typeof pads)[number], grow = 0) {
    ctx.beginPath()
    if (p.shape === 'round') {
      ctx.ellipse(px(p.x), py(p.y), mm(p.w / 2 + grow), mm(p.h / 2 + grow), 0, 0, Math.PI * 2)
    } else {
      const r = Math.min(p.w, p.h) * 0.18
      ctx.roundRect(px(p.x - p.w / 2 - grow), py(p.y - p.h / 2 - grow), mm(p.w + grow * 2), mm(p.h + grow * 2), mm(r))
    }
  }

  function paint(o: ArtworkOptions) {
    // ---------- colour ----------
    const c = colorC.getContext('2d')!
    grain(c, W, H, 13, 5)
    c.lineCap = 'round'
    c.lineJoin = 'round'
    // copper pour shimmer under mask: very faint
    c.fillStyle = 'rgba(255,255,255,0.012)'
    c.fillRect(0, 0, W, H)
    if (o.traces) {
      for (const t of traces) {
        tracePath(c, t)
        c.strokeStyle = t.layer === 'top' ? 'rgba(62,66,70,0.95)' : 'rgba(30,32,34,0.6)'
        c.lineWidth = mm(t.width)
        c.stroke()
      }
    }
    // via tents
    for (const [x, y] of vias) {
      c.beginPath()
      c.arc(px(x), py(y), mm(0.42), 0, Math.PI * 2)
      c.fillStyle = '#2b2e31'
      c.fill()
      c.beginPath()
      c.arc(px(x), py(y), mm(0.17), 0, Math.PI * 2)
      c.fillStyle = '#050505'
      c.fill()
    }
    // mask-defined openings: ENIG pads
    for (const p of pads) {
      padShape(c, p, 0.06)
      c.fillStyle = '#070808'
      c.fill()
      padShape(c, p)
      const g = c.createLinearGradient(px(p.x - p.w / 2), py(p.y - p.h / 2), px(p.x + p.w / 2), py(p.y + p.h / 2))
      g.addColorStop(0, '#d9d4c4')
      g.addColorStop(0.5, '#b9b29f')
      g.addColorStop(1, '#cfc8b5')
      c.fillStyle = g
      c.fill()
      if (p.drill) {
        c.beginPath()
        c.arc(px(p.x), py(p.y), mm(p.drill / 2), 0, Math.PI * 2)
        c.fillStyle = '#030303'
        c.fill()
      }
    }
    // mounting holes: plated rings
    for (const h of board.holes) {
      c.beginPath()
      c.arc(px(h.x), py(h.y), mm(h.d / 2 + 1.1), 0, Math.PI * 2)
      c.fillStyle = '#c4bdaa'
      c.fill()
    }
    if (o.silk) paintSilk(c)

    // ---------- roughness / metalness ----------
    const r = ormC.getContext('2d')!
    r.fillStyle = 'rgb(0,150,0)' // matte mask
    r.fillRect(0, 0, W, H)
    r.lineCap = 'round'
    if (o.traces) {
      for (const t of traces) {
        tracePath(r, t)
        r.strokeStyle = 'rgb(0,108,0)' // mask over copper is a touch glossier
        r.lineWidth = mm(t.width)
        r.stroke()
      }
    }
    for (const p of pads) {
      padShape(r, p)
      r.fillStyle = 'rgb(0,72,255)'
      r.fill()
    }
    for (const h of board.holes) {
      r.beginPath()
      r.arc(px(h.x), py(h.y), mm(h.d / 2 + 1.1), 0, Math.PI * 2)
      r.fillStyle = 'rgb(0,80,255)'
      r.fill()
    }

    // ---------- bump ----------
    const b = bumpC.getContext('2d')!
    b.fillStyle = '#404040'
    b.fillRect(0, 0, W, H)
    b.lineCap = 'round'
    b.lineJoin = 'round'
    b.filter = 'blur(1.2px)'
    if (o.traces) {
      for (const t of traces) {
        if (t.layer !== 'top') continue
        tracePath(b, t)
        b.strokeStyle = '#9a9a9a'
        b.lineWidth = mm(t.width + 0.08)
        b.stroke()
      }
    }
    for (const p of pads) {
      padShape(b, p)
      b.fillStyle = '#a8a8a8'
      b.fill()
    }
    if (o.silk) {
      b.filter = 'none'
      b.globalAlpha = 0.8
      paintSilk(b, '#7a7a7a')
      b.globalAlpha = 1
    }
    b.filter = 'none'

    color.needsUpdate = orm.needsUpdate = bump.needsUpdate = true
  }

  function paintSilk(c: CanvasRenderingContext2D, ink = '#e9e9e4') {
    c.save()
    c.strokeStyle = ink
    c.fillStyle = ink
    c.lineWidth = mm(0.15)
    c.lineCap = 'round'
    // board outline keep-in
    c.strokeRect(mm(1.2), mm(1.2), W - mm(2.4), H - mm(2.4))
    for (const p of board.parts) {
      const body = bodyFor(p)
      const quarter = Math.round(((p.rot % 180) + 180) % 180) === 90
      const w = (quarter ? body.h : body.w) + 0.5
      const h = (quarter ? body.w : body.h) + 0.5
      if (p.kind !== 'chip') {
        // corner brackets, like a real assembly silkscreen
        const x0 = px(p.x - w / 2), y0 = py(p.y - h / 2), x1 = px(p.x + w / 2), y1 = py(p.y + h / 2)
        const L = mm(Math.min(1.6, w / 4, h / 4))
        c.beginPath()
        for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) {
          c.moveTo(cx + dx * L, cy)
          c.lineTo(cx, cy)
          c.lineTo(cx, cy + dy * L)
        }
        c.stroke()
        // pin-1 dot
        if (['ssop', 'soic', 'module', 'sot223'].includes(p.kind)) {
          const [dx, dy] = toBoard(p, -body.w / 2 - 0.9, -body.h / 2 + 0.6)
          c.beginPath()
          c.arc(px(dx), py(dy), mm(0.32), 0, Math.PI * 2)
          c.fill()
        }
      }
      // designator
      const size = p.kind === 'chip' || p.kind === 'led' ? 0.9 : 1.25
      c.font = `600 ${mm(size)}px "Geist Mono", ui-monospace, monospace`
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      const off = p.kind === 'chip' || p.kind === 'led' ? 1.25 : h / 2 + 1.25
      const ty = p.y - off < -board.height / 2 + 2 ? p.y + off : p.y - off
      c.fillText(p.ref, px(p.x), py(ty))
    }
    // terminal polarity marks
    // board title block
    c.textAlign = 'left'
    c.textBaseline = 'alphabetic'
    c.font = `700 ${mm(2.1)}px "Geist", ui-sans-serif, sans-serif`
    c.fillText('FORGE', mm(5.5), H - mm(5))
    c.font = `500 ${mm(1.05)}px "Geist Mono", ui-monospace, monospace`
    c.fillText(`${board.name.toUpperCase()}  ·  REV ${board.revision}`, mm(5.5), H - mm(3.1))
    c.textAlign = 'right'
    c.fillText(`${board.width}×${board.height} MM  ·  ${board.thickness} MM FR-4  ·  ENIG`, W - mm(5.5), H - mm(3.1))
    // little forge mark
    c.lineWidth = mm(0.3)
    c.strokeRect(mm(2.2), H - mm(7.1), mm(2.4), mm(2.4))
    c.fillRect(mm(2.85), H - mm(6.45), mm(1.1), mm(1.1))
    c.restore()
  }

  paint(opts)
  return {
    color,
    orm,
    bump,
    repaint: paint,
    dispose() {
      color.dispose()
      orm.dispose()
      bump.dispose()
    },
  }
}
