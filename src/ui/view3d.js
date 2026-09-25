/**
 * 3D-вид навеса на three.js.
 *
 * Детали берутся из buildSolids() — той же геометрии, что у расчёта. Каждая
 * окрашена по коэффициенту использования цветами палитры текущей темы; клик по
 * детали выбирает её, как на плане. Вращение, приближение и сдвиг — мышью и
 * пальцами (OrbitControls). Кадр перерисовывается только когда что-то
 * изменилось: вид не держит видеокарту занятой, пока на него не смотрят.
 *
 * Модуль не знает состояния приложения: create3D(host, { onPick }) и дальше
 * update(res, sel) на каждую перерисовку — как у остальных видов.
 *
 * Стена дома с окнами и дверями — только ориентир (buildContext): не
 * выбирается и не красится по U.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, BoxGeometry, MeshLambertMaterial, MeshBasicMaterial,
  Mesh, AmbientLight, DirectionalLight, Raycaster, Vector2, Vector3, Matrix4, EdgesGeometry,
  LineSegments, LineBasicMaterial, Color, Group, PlaneGeometry,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildSolids, buildContext, selectionBox } from './solids.js';

const MM = 1 / 1000; // сцена в метрах: камере удобнее

/** Цвет CSS-переменной палитры — берётся из текущей темы. */
function token(name) {
  return new Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888');
}
const uToken = (U) => (!Number.isFinite(U) || U > 1 ? '--u-bad' : U > 0.85 ? '--u-warn' : U > 0.5 ? '--u-ok' : '--u-low');

/** Брусок между двумя точками: ось from→to, сечение w × h, h вдоль up. */
function bar(e, material) {
  const from = new Vector3(...e.from).multiplyScalar(MM);
  const to = new Vector3(...e.to).multiplyScalar(MM);
  const axis = to.clone().sub(from);
  const len = axis.length();
  axis.normalize();
  const up = new Vector3(...e.up);
  up.sub(axis.clone().multiplyScalar(up.dot(axis))).normalize(); // up перпендикулярно оси
  // правая тройка (side, axis, up): side × axis = up, иначе поворот зеркальный
  const side = new Vector3().crossVectors(axis, up).normalize();
  const mesh = new Mesh(new BoxGeometry(e.w * MM, len, e.h * MM), material);
  // локальные оси бруска: x — поперёк (w), y — вдоль оси, z — по up (h)
  mesh.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(side, axis, up));
  mesh.position.copy(from.add(to).multiplyScalar(0.5));
  return mesh;
}

export function create3D(host, { onPick }) {
  let renderer;
  try {
    // preserveDrawingBuffer — чтобы кадр можно было снять (скриншот, смоук)
    renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    host.innerHTML = '<div class="hint" style="border:0;padding:24px">3D-вид недоступен: браузер не дал WebGL. План, разрез и узлы работают как обычно.</div>';
    return null;
  }
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  host.innerHTML = '';
  host.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '3D-вид навеса');

  const scene = new Scene();
  // z вверх, как в расчёте
  const camera = new PerspectiveCamera(40, 1, 0.05, 200);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.addEventListener('change', () => draw());

  scene.add(new AmbientLight(0xffffff, 1.6));
  const sun = new DirectionalLight(0xffffff, 1.8);
  sun.position.set(-6, 9, 12);
  scene.add(sun);

  const parts = new Group();
  scene.add(parts);
  let pickable = [];
  let framed = false;
  let lastRes = null;

  function draw() {
    renderer.render(scene, camera);
  }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    draw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  /** Камера на навес целиком: сбоку-спереди и сверху, как смотрят с участка. */
  function frame(res) {
    const { B, L, a } = res.model.geom;
    const cx = (B / 2) * MM, cy = ((L + a) / 2) * MM, cz = 1.4;
    const r = Math.max(B, L + a) * MM;
    controls.target.set(cx, cy, cz);
    camera.position.set(cx - r * 0.55, cy + r * 1.35, cz + r * 0.8);
    camera.lookAt(controls.target);
    controls.update();
  }

  function clear() {
    for (const o of [...parts.children]) {
      parts.remove(o);
      o.traverse?.((n) => { n.geometry?.dispose?.(); });
    }
    pickable = [];
  }

  function update(res, sel) {
    lastRes = res;
    clear();
    const ink = token('--ink'), rule = token('--ink-3');

    // стена дома и земля — ориентир, светлые и полупрозрачные
    const ctx = buildContext(res);
    const wall = bar(ctx.wall, new MeshLambertMaterial({ color: token('--rule-2'), transparent: true, opacity: 0.6 }));
    const wallEdges = new LineSegments(new EdgesGeometry(wall.geometry), new LineBasicMaterial({ color: rule, transparent: true, opacity: 0.6 }));
    wallEdges.quaternion.copy(wall.quaternion);
    wallEdges.position.copy(wall.position);
    parts.add(wall, wallEdges);
    // окна и двери — щиты в проёмах: окно — стекло, дверь — глухая, с контуром рамы
    const frameMat = new LineBasicMaterial({ color: token('--ink-2') });
    for (const o of ctx.openings) {
      const leaf = bar(o, new MeshLambertMaterial(o.kind === 'door'
        ? { color: token('--ink-3'), transparent: true, opacity: 0.85 }
        : { color: token('--accent-2'), transparent: true, opacity: 0.7 }));
      const frame = new LineSegments(new EdgesGeometry(leaf.geometry), frameMat);
      frame.quaternion.copy(leaf.quaternion);
      frame.position.copy(leaf.position);
      parts.add(leaf, frame);
    }
    const ground = new Mesh(new PlaneGeometry(ctx.ground.size * MM, ctx.ground.size * MM),
      new MeshBasicMaterial({ color: token('--sunk'), transparent: true, opacity: 0.82, depthWrite: false }));
    ground.renderOrder = 1; // поверх фундаментов: они под землёй и видны сквозь неё приглушённо
    ground.position.set(ctx.ground.center[0] * MM, ctx.ground.center[1] * MM, -0.001);
    parts.add(ground);

    const materials = new Map();
    const matFor = (key) => {
      if (!materials.has(key)) materials.set(key, new MeshLambertMaterial({ color: token(key) }));
      return materials.get(key);
    };
    for (const e of buildSolids(res)) {
      const mat = e.ghost
        ? new MeshLambertMaterial({ color: token('--accent-2'), transparent: true, opacity: 0.12, depthWrite: false })
        : matFor(uToken(e.U));
      const mesh = bar(e, mat);
      mesh.userData = { sel: e.sel, label: e.label };
      parts.add(mesh);
      if (!e.ghost) {
        const chosen = e.sel && sel && e.sel.type === sel.type
          && (e.sel.index === undefined || e.sel.index === sel.index)
          && (e.sel.side === undefined || e.sel.side === (sel.side ?? 'outer'));
        // у выбранной — рамка с постоянным отступом (selectionBox), а не растянутая копия
        const box = chosen ? selectionBox(e) : null;
        const shape = box ? new BoxGeometry(box.w * MM, box.len * MM, box.h * MM) : mesh.geometry;
        const edges = new LineSegments(new EdgesGeometry(shape),
          new LineBasicMaterial({ color: chosen ? ink : rule, transparent: !chosen, opacity: chosen ? 1 : 0.35 }));
        if (box) shape.dispose(); // рёбра уже построены, сам брусок рамки не нужен
        edges.quaternion.copy(mesh.quaternion);
        edges.position.copy(mesh.position);
        parts.add(edges);
        pickable.push(mesh);
      }
    }
    if (!framed) { frame(res); framed = true; }
    resize();
  }

  // клик без перетаскивания — выбор детали
  const raycaster = new Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
    down = null;
    const hit = pickAt(e.clientX, e.clientY);
    if (hit) onPick(hit);
  });

  function pickAt(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    const p = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(p, camera);
    const hit = raycaster.intersectObjects(pickable, false)[0];
    return hit?.object.userData.sel ?? null;
  }

  /** Где на экране центр детали — для проверки кликом в смоуке. */
  function screenOf(sel) {
    const mesh = pickable.find((m) => {
      const s = m.userData.sel;
      return s && s.type === sel.type && (sel.index === undefined || s.index === sel.index);
    });
    if (!mesh) return null;
    const v = mesh.position.clone().project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  return {
    update,
    reset() { if (lastRes) { frame(lastRes); draw(); } },
    zoom(factor) {
      const off = camera.position.clone().sub(controls.target).multiplyScalar(1 / factor);
      camera.position.copy(controls.target.clone().add(off));
      controls.update();
    },
    screenOf,
    /** Сколько пикселей кадра не пусты — для смоука: сцена действительно нарисована. */
    painted() {
      const c = renderer.domElement;
      const probe = document.createElement('canvas');
      probe.width = 64; probe.height = 64;
      const g = probe.getContext('2d');
      g.drawImage(c, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n / (64 * 64);
    },
    dispose() {
      ro.disconnect();
      controls.dispose();
      clear();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
