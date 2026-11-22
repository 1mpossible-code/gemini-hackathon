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

const EXPLODE_OFFSETS = {
  "sensor-1": 0.012,
  "sensor-2": 0.012,
  board: 0.028,
  "enclosure-lid": 0.045,
};
const PRESET_ANGLES = {
  iso: new Vector3(1.1, 0.78, 1.5).normalize(),
  top: new Vector3(0.01, 1.95, 0.08).normalize(),
  front: new Vector3(0.0, 0.24, 1.8).normalize(),
};

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
  constructor(container, onPick, onContextLost, onHover) {
    this.onPick = onPick;
    this.onHover = onHover;
    this.hoverFrame = 0;
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(35, 1, 0.004, 12);
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.model = null;
    this.loadToken = 0;
    this.exploded = true;
    this.wireframe = false;
    this.selectedId = null;
    this.nodeIds = new Map();
    this.parts = new Map();
    this.explodedParts = new Map();
    this.loader = new GLTFLoader();
    this.raycaster = new Raycaster();

    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute(
      "aria-label",
      "Interactive 3D hardware assembly. Drag or use arrow keys to orbit, scroll to zoom, click a component to inspect."
    );
    container.replaceChildren(canvas);
    canvas.addEventListener("webglcontextlost", event => {
      event.preventDefault();
      this.contextLost = true;
      onContextLost?.();
    });

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = true;
    this.controls.rotateSpeed = 0.82;
    this.controls.minDistance = 0.035;
    this.controls.maxDistance = 2.2;
    this.controls.addEventListener("change", () => this.render());
    canvas.addEventListener("keydown", event => this.orbitWithKey(event));
    canvas.addEventListener("pointerdown", event => {
      this.pointerStart =
        event.isPrimary && event.button === 0
          ? new Vector2(event.clientX, event.clientY)
          : null;
    });
    canvas.addEventListener("pointerup", event => this.pick(event));
    canvas.addEventListener("pointercancel", () => {
      this.pointerStart = null;
    });
    canvas.addEventListener("pointermove", event => {
      if (!this.onHover || event.buttons) {
        if (event.buttons) this.onHover?.(null, event.clientX, event.clientY);
        return;
      }
      const { clientX, clientY } = event;
      cancelAnimationFrame(this.hoverFrame);
      this.hoverFrame = requestAnimationFrame(() =>
        this.onHover(this.idAt(clientX, clientY), clientX, clientY)
      );
    });
    canvas.addEventListener("pointerleave", event => {
      cancelAnimationFrame(this.hoverFrame);
      this.onHover?.(null, event.clientX, event.clientY);
    });

    this.scene.add(new HemisphereLight(0xf2f3f0, 0x5c626b, 2.2));
    const key = new DirectionalLight(0xffffff, 2.7);
    key.position.set(1.1, 2.1, 1.4);
    this.scene.add(key);
    const rim = new DirectionalLight(0xd9e6f5, 1.85);
    rim.position.set(-1.3, 0.9, -0.95);
    this.scene.add(rim);

    this.grid = new GridHelper(0.65, 58, 0x4b535e, 0x2d333b);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.34;
    this.scene.add(this.grid);
    this.grid.visible = false;

    this.highlight = new Box3Helper(new Box3(), new Color(0xf5c86b));
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

  async load(glbUrl, manifest, { keepView = false } = {}) {
    const token = ++this.loadToken;
    const source = new URL(glbUrl, window.location.href);
    if (source.origin !== window.location.origin) {
      throw new Error("Model URL must be local.");
    }
    const { scene } = await this.loader.loadAsync(source.href);
    if (token !== this.loadToken) {
      disposeModel(scene);
      return false;
    }
    this.removeModel();
    this.model = scene;
    this.nodeIds = new Map(
      manifest.nodes.map(node => [node.id, node.part_instance_id || node.id])
    );
    this.model.traverse(object => {
      if (!this.nodeIds.has(object.name)) return;
      const id = this.nodeIds.get(object.name);
      if (!this.parts.has(id)) this.parts.set(id, []);
      this.parts.get(id).push(object);
      if (
        Object.hasOwn(EXPLODE_OFFSETS, id) &&
        this.nodeIds.get(object.parent?.name) !== id
      ) {
        this.explodedParts.set(object, [
          object.position.clone(),
          EXPLODE_OFFSETS[id],
        ]);
      }
    });
    this.scene.add(this.model);
    this.applyWireframe();
    this.bounds = new Box3().setFromObject(this.model);
    this.grid.position.y = this.bounds.min.y - 0.004;
    this.grid.visible = true;
    this.setExploded(this.exploded);
    if (!keepView) this.reset("iso");
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

  reset(preset = "iso") {
    if (!this.model) return;
    const angle = PRESET_ANGLES[preset] || PRESET_ANGLES.iso;
    const displayBounds = new Box3().setFromObject(this.model);
    const size = displayBounds.getSize(new Vector3());
    const center = displayBounds.getCenter(new Vector3());
    const vertical = (this.camera.fov * Math.PI) / 360;
    const horizontal = Math.atan(Math.tan(vertical) * Math.max(this.camera.aspect, 0.5));
    const radius = Math.max(size.x, size.y, size.z) * 0.62;
    const distance = Math.max(radius / Math.sin(Math.min(vertical, horizontal)), 0.11);
    this.camera.position.copy(center).addScaledVector(angle, distance);
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

  setWireframe(enabled) {
    this.wireframe = enabled;
    this.applyWireframe();
    this.render();
  }

  applyWireframe() {
    if (!this.model) return;
    this.model.traverse(object => {
      if (!object.isMesh) return;
      for (const mat of [object.material].flat()) {
        mat.wireframe = this.wireframe;
      }
    });
  }

  setSelection(id) {
    this.selectedId = id;
    const selected = this.parts.get(id);
    this.highlight.visible = Boolean(selected?.length);
    if (selected?.length && this.model) {
      this.model.updateMatrixWorld();
      this.highlight.box.makeEmpty();
      selected.forEach(part => this.highlight.box.expandByObject(part));
      this.highlight.box.expandByScalar(0.0016);
    }
    this.render();
  }

  pick(event) {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (
      !this.model ||
      !start ||
      start.distanceTo(new Vector2(event.clientX, event.clientY)) > 5
    ) {
      return;
    }
    const id = this.idAt(event.clientX, event.clientY);
    if (id) this.onPick?.(id);
  }

  idAt(clientX, clientY) {
    if (!this.model) return null;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new Vector2(
      (2 * (clientX - bounds.left)) / bounds.width - 1,
      1 - (2 * (clientY - bounds.top)) / bounds.height
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    for (const hit of this.raycaster.intersectObject(this.model, true)) {
      let object = hit.object;
      while (object && object !== this.model) {
        const id = this.nodeIds.get(object.name);
        if (id) return id;
        object = object.parent;
      }
    }
    return null;
  }

  orbitWithKey(event) {
    const increments = {
      ArrowLeft: [-0.14, 0],
      ArrowRight: [0.14, 0],
      ArrowUp: [0, -0.14],
      ArrowDown: [0, 0.14],
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
