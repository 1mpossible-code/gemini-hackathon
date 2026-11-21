import {
  Box3,
  Box3Helper,
  Color,
  DirectionalLight,
  GLTFLoader,
  GridHelper,
  HemisphereLight,
  OrbitControls,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Spherical,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "./vendor/three-runtime.js";

const EXPLODE_OFFSETS = { "sensor-1": .012, board: .028, "enclosure-lid": .043 };
const CAMERA_ANGLE = new Vector3(1.10, 0.78, 1.5).normalize();

function disposeModel(model) {
  const materials = new Set();
  const geometries = new Set();
  model.traverse(object => {
    if (!object.isMesh) return;
    geometries.add(object.geometry);
    for (const material of [object.material].flat()) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

export class AssemblyViewer {
  constructor(container, onPick, onContextLost) {
    this.onPick = onPick;
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(36, 1, 0.004, 12);
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.model = null;
    this.loadToken = 0;
    this.exploded = true;
    this.selectedId = null;
    this.nodeIds = new Map();
    this.parts = new Map();
    this.explodedParts = new Map();
    this.loader = new GLTFLoader();
    this.raycaster = new Raycaster();

    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "3D assembly viewport. Use the arrow keys to orbit.");
    canvas.setAttribute("aria-describedby", "view-help");
    container.replaceChildren(canvas);
    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      this.contextLost = true;
      onContextLost();
    });

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.rotateSpeed = .8;
    this.controls.minDistance = .035;
    this.controls.maxDistance = 2;
    this.controls.addEventListener("change", () => this.render());
    canvas.addEventListener("keydown", event => this.orbitWithKey(event));
    canvas.addEventListener("pointerdown", event => {
      this.pointerStart = event.isPrimary && event.button === 0
        ? new Vector2(event.clientX, event.clientY)
        : null;
    });
    canvas.addEventListener("pointerup", event => this.pick(event));
    canvas.addEventListener("pointercancel", () => { this.pointerStart = null; });

    this.scene.add(new HemisphereLight(0xf0f0ec, 0x666666, 2.1));
    const key = new DirectionalLight(0xffffff, 2.6);
    key.position.set(1, 2, 1.4);
    this.scene.add(key);
    const rim = new DirectionalLight(0xf0f0ef, 1.9);
    rim.position.set(-1.2, .85, -.9);
    this.scene.add(rim);
    this.grid = new GridHelper(.65, 58, 0x545557, 0x454648);
    this.grid.material.transparent = true;
    this.grid.material.opacity = .28;
    this.scene.add(this.grid);
    this.grid.visible = false;

    this.highlight = new Box3Helper(new Box3(), new Color(0xecebe6));
    this.highlight.material.depthTest = false;
    this.highlight.renderOrder = 20;
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width < 1 || height < 1) return;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height, false);
      this.render();
    }).observe(container);
  }

  async load(prototype, { keepView = false } = {}) {
    const token = ++this.loadToken;
    const source = new URL(prototype.glb_url, window.location.href);
    if (source.origin !== window.location.origin) throw new Error("Model URL must be local.");
    const { scene } = await this.loader.loadAsync(source.href);
    if (token !== this.loadToken) {
      disposeModel(scene);
      return false;
    }
    this.removeModel();
    this.model = scene;
    this.nodeIds = new Map(prototype.manifest.nodes.map(node => [
      node.id,
      node.part_instance_id || node.id,
    ]));
    this.model.traverse(object => {
      if (!this.nodeIds.has(object.name)) return;
      const id = this.nodeIds.get(object.name);
      if (!this.parts.has(id)) this.parts.set(id, []);
      this.parts.get(id).push(object);
      if (Object.hasOwn(EXPLODE_OFFSETS, id) && this.nodeIds.get(object.parent?.name) !== id) {
        this.explodedParts.set(object, [object.position.clone(), EXPLODE_OFFSETS[id]]);
      }
    });
    this.scene.add(this.model);
    this.bounds = new Box3().setFromObject(this.model);
    this.grid.position.y = this.bounds.min.y - .004;
    this.grid.visible = true;
    this.setExploded(this.exploded);
    if (!keepView) this.reset();
    return true;
  }

  removeModel() {
    if (this.model) {
      this.scene.remove(this.model);
      disposeModel(this.model);
    }
    this.model = null;
    this.parts.clear();
    this.explodedParts.clear();
    this.highlight.visible = false;
  }

  clear() {
    this.loadToken += 1;
    this.removeModel();
    this.grid.visible = false;
    this.render();
  }

  reset() {
    if (!this.model) return;
    const displayBounds = new Box3().setFromObject(this.model);
    const size = displayBounds.getSize(new Vector3());
    const center = displayBounds.getCenter(new Vector3());
    const vertical = this.camera.fov * Math.PI / 360;
    const horizontal = Math.atan(Math.tan(vertical) * this.camera.aspect);
    const radius = Math.max(size.x, size.y, size.z) * .64;
    const distance = Math.max(radius / Math.sin(Math.min(vertical, horizontal)), .1);
    this.camera.position.copy(center).addScaledVector(CAMERA_ANGLE, distance);
    this.controls.target.copy(center);
    this.controls.update();
    this.render();
  }

  setExploded(exploded) {
    this.exploded = exploded;
    for (const [object, [position, offset]] of this.explodedParts) {
      object.position.copy(position);
      if (exploded) object.position.y += offset;
    }
    this.setSelection(this.selectedId);
  }

  setSelection(id) {
    this.selectedId = id;
    const selected = this.parts.get(id);
    this.highlight.visible = Boolean(selected?.length);
    if (selected?.length) {
      this.model.updateMatrixWorld();
      this.highlight.box.makeEmpty();
      selected.forEach(part => this.highlight.box.expandByObject(part));
      this.highlight.box.expandByScalar(.0015);
    }
    this.render();
  }

  pick(event) {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (!this.model || !start || start.distanceTo(new Vector2(event.clientX, event.clientY)) > 5) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new Vector2(
      2 * (event.clientX - bounds.left) / bounds.width - 1,
      1 - 2 * (event.clientY - bounds.top) / bounds.height,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    for (const hit of this.raycaster.intersectObject(this.model, true)) {
      let object = hit.object;
      while (object && object !== this.model) {
        const id = this.nodeIds.get(object.name);
        if (id) {
          this.onPick(id);
          return;
        }
        object = object.parent;
      }
    }
  }

  orbitWithKey(event) {
    const increments = {
      ArrowLeft: [-.14, 0],
      ArrowRight: [.14, 0],
      ArrowUp: [0, -.14],
      ArrowDown: [0, .14],
    };
    const step = increments[event.key];
    if (!this.model || !step) return;
    event.preventDefault();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const orbit = new Spherical().setFromVector3(offset);
    orbit.theta += step[0];
    orbit.phi += step[1];
    orbit.makeSafe();
    this.camera.position.copy(this.controls.target).add(offset.setFromSpherical(orbit));
    this.controls.update();
  }

  render() {
    if (!this.contextLost) this.renderer.render(this.scene, this.camera);
  }
}
