// WebGL layers for the research graph (three.js).
// Back canvas: dot field, wire bundles between nodes and the bus, moving packets.
// Front canvas: wireframe cube lattices drawn into the viz slot of running nodes.
// The HTML nodes sit between the two canvases, so wires pass behind the cards.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Scene,
  WebGLRenderer,
} from "./vendor/three-graph.js";

const SEGMENTS = 28;
const MAX_PACKETS = 480;
// Wire shade per level: 0 fabric, 1 idle, 2 done, 3 live.
const SHADES = [0x1a1a1a, 0x2f2f2f, 0x6e6e6e, 0xf2f2f2];
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

function bezier(p, t, out) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  out[0] = a * p[0] + b * p[2] + c * p[4] + d * p[6];
  out[1] = a * p[1] + b * p[3] + c * p[5] + d * p[7];
  return out;
}

function makeRenderer(canvas) {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

function lattice(size) {
  const n = size;
  const positions = [];
  const index = (x, y, z) => x + y * n + z * n * n;
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) positions.push(x / (n - 1) - 0.5, y / (n - 1) - 0.5, z / (n - 1) - 0.5);
  const segments = [];
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const i = index(x, y, z) * 3;
        const from = positions.slice(i, i + 3);
        if (x + 1 < n) segments.push(...from, ...positions.slice(index(x + 1, y, z) * 3, index(x + 1, y, z) * 3 + 3));
        if (y + 1 < n) segments.push(...from, ...positions.slice(index(x, y + 1, z) * 3, index(x, y + 1, z) * 3 + 3));
        if (z + 1 < n) segments.push(...from, ...positions.slice(index(x, y, z + 1) * 3, index(x, y, z + 1) * 3 + 3));
      }
  const edges = new BufferGeometry();
  edges.setAttribute("position", new BufferAttribute(new Float32Array(segments), 3));
  const points = new BufferGeometry();
  points.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  const colors = new Float32Array(positions.length);
  points.setAttribute("color", new BufferAttribute(colors, 3).setUsage(DynamicDrawUsage));
  const group = new Group();
  group.add(
    new LineSegments(edges, new LineBasicMaterial({ color: 0x3a3a3a })),
    new Points(points, new PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true })),
  );
  return { group, colors, count: n * n * n, attribute: points.getAttribute("color") };
}

export function createGraphGL(back, front, host) {
  let backRenderer, frontRenderer;
  try {
    backRenderer = makeRenderer(back);
    frontRenderer = makeRenderer(front);
  } catch {
    back.hidden = true;
    front.hidden = true;
    return null;
  }
  frontRenderer.setScissorTest(true);

  const backScene = new Scene();
  const ortho = new OrthographicCamera(0, 1, 0, -1, -10, 10);
  const dots = new Points(new BufferGeometry(), new PointsMaterial({ color: 0x1c1c1c, size: 1.5, sizeAttenuation: false }));
  const wireGeometry = new BufferGeometry();
  const wires = new LineSegments(wireGeometry, new LineBasicMaterial({ vertexColors: true }));
  const packets = new InstancedMesh(new PlaneGeometry(3, 3), new MeshBasicMaterial({ color: 0xffffff }), MAX_PACKETS);
  packets.instanceMatrix.setUsage(DynamicDrawUsage);
  packets.count = 0;
  backScene.add(dots, wires, packets);

  const frontScene = new Scene();
  const cube = lattice(4);
  frontScene.add(cube.group);
  const perspective = new PerspectiveCamera(32, 1, 0.1, 20);
  perspective.position.set(0, 0, 3.4);

  let width = 1, height = 1, edges = [], targets = () => [], frame = 0;
  const point = [0, 0];
  const dummy = new Object3D();
  const shade = new Color();
  const lit = new Color(0xf2f2f2), dim = new Color(0x3c3c3c), mid = new Color(0x8a8a8a);

  function layoutDots() {
    const step = 16, list = [];
    for (let y = step / 2; y < height; y += step)
      for (let x = step / 2; x < width; x += step) list.push(x, -y, 0);
    dots.geometry.dispose();
    dots.geometry = new BufferGeometry();
    dots.geometry.setAttribute("position", new BufferAttribute(new Float32Array(list), 3));
  }

  function resize() {
    width = Math.max(1, host.clientWidth);
    height = Math.max(1, host.clientHeight);
    backRenderer.setSize(width, height, true);
    frontRenderer.setSize(width, height, true);
    ortho.right = width;
    ortho.bottom = -height;
    ortho.updateProjectionMatrix();
    layoutDots();
  }

  // edges: [{ p: [x0,y0, x1,y1, x2,y2, x3,y3], level: 0..3, packets: n, speed }]
  function setEdges(next) {
    edges = next;
    const positions = new Float32Array(edges.length * SEGMENTS * 6);
    const colors = new Float32Array(edges.length * SEGMENTS * 6);
    let o = 0;
    for (const edge of edges) {
      shade.setHex(SHADES[edge.level] ?? SHADES[1]);
      let [px, py] = bezier(edge.p, 0, point);
      for (let s = 1; s <= SEGMENTS; s++) {
        const [x, y] = bezier(edge.p, s / SEGMENTS, point);
        positions.set([px, -py, 0, x, -y, 0], o);
        colors.set([shade.r, shade.g, shade.b, shade.r, shade.g, shade.b], o);
        o += 6;
        px = x;
        py = y;
      }
    }
    wireGeometry.setAttribute("position", new BufferAttribute(positions, 3));
    wireGeometry.setAttribute("color", new BufferAttribute(colors, 3));
    wireGeometry.computeBoundingSphere();
  }

  function drawPackets(time) {
    let n = 0;
    const moving = !reducedMotion.matches;
    for (const edge of edges) {
      if (!edge.packets) continue;
      for (let i = 0; i < edge.packets && n < MAX_PACKETS; i++) {
        const t = moving ? (time * edge.speed + i / edge.packets) % 1 : (i + 0.5) / edge.packets;
        const [x, y] = bezier(edge.p, t, point);
        dummy.position.set(Math.round(x) + 0.5, -Math.round(y) - 0.5, 1);
        dummy.updateMatrix();
        packets.setMatrixAt(n, dummy.matrix);
        packets.setColorAt(n, edge.level >= 3 ? lit : mid);
        n++;
      }
    }
    packets.count = n;
    packets.instanceMatrix.needsUpdate = true;
    if (packets.instanceColor) packets.instanceColor.needsUpdate = true;
  }

  function drawLattices(time) {
    frontRenderer.setScissor(0, 0, width, height);
    frontRenderer.setViewport(0, 0, width, height);
    frontRenderer.clear();
    const box = host.getBoundingClientRect();
    for (const target of targets()) {
      const rect = target.el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const left = rect.left - box.left;
      const bottom = box.bottom - rect.bottom;
      if (left > width || bottom > height || left + rect.width < 0 || bottom + rect.height < 0) continue;
      // Lit points: a scan that sweeps the lattice while running, all lit when done.
      const sweep = target.progress ?? ((time * 0.6 + target.seed) % 1);
      const head = Math.floor(sweep * cube.count);
      for (let i = 0; i < cube.count; i++) {
        const on = target.progress != null ? i < head : i <= head && i > head - 9;
        const c = on ? lit : i < head ? mid : dim;
        cube.colors.set([c.r, c.g, c.b], i * 3);
      }
      cube.attribute.needsUpdate = true;
      const spin = reducedMotion.matches ? 0.6 : time * 0.35 + target.seed * 6;
      cube.group.rotation.set(0.52, spin, 0);
      perspective.aspect = rect.width / rect.height;
      perspective.updateProjectionMatrix();
      frontRenderer.setScissor(left, bottom, rect.width, rect.height);
      frontRenderer.setViewport(left, bottom, rect.width, rect.height);
      frontRenderer.render(frontScene, perspective);
    }
  }

  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (!host.offsetParent || document.hidden) return;
    const time = now / 1000;
    drawPackets(time);
    backRenderer.render(backScene, ortho);
    drawLattices(time);
  }

  resize();
  frame = requestAnimationFrame(tick);

  return {
    resize,
    setEdges,
    setTargets(fn) {
      targets = fn;
    },
    dispose() {
      cancelAnimationFrame(frame);
      backRenderer.dispose();
      frontRenderer.dispose();
    },
  };
}
