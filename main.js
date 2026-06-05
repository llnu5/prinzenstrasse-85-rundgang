import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';

// ---------------------------------------------------------------------------
//  Szene, Kamera, Renderer
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.02, 2000);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Unbeleuchtete, fotografisch gebackene Texturen -> ohne Tone-Mapping
// werden die Original-Farben des Scans am genauesten wiedergegeben.
renderer.toneMapping = THREE.NoToneMapping;
app.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;

// ---------------------------------------------------------------------------
//  Licht – Matterport-Texturen sind bereits "gebacken", daher kräftiges
//  Ambient-Licht damit alles gut sichtbar ist.
// ---------------------------------------------------------------------------
const baseHemi = new THREE.HemisphereLight(0xffffff, 0x404550, 2.2); baseHemi.name = 'baselight';
const dir = new THREE.DirectionalLight(0xffffff, 1.1); dir.position.set(5, 12, 8); dir.name = 'baselight';
const dir2 = new THREE.DirectionalLight(0xffffff, 0.5); dir2.position.set(-8, 6, -6); dir2.name = 'baselight';
scene.add(baseHemi, dir, dir2);

// ---------------------------------------------------------------------------
//  Zustand
// ---------------------------------------------------------------------------
let model = null;
let modelCenter = new THREE.Vector3();
let modelRadius = 10;
let modelBox = new THREE.Box3();
let litModel = false;          // true bei Rhino/CAD (beleuchtet) -> Daylight-Panel
let projectData = null;        // geladene Projekt-Zeile (inkl. settings)
const home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
let mode = 'walk';            // 'walk' | 'orbit'

// ---------------------------------------------------------------------------
//  Modell laden – je nach Projekt: Standard-GLB / Matterport-ZIP / Rhino-.3dm
// ---------------------------------------------------------------------------
const loaderEl = document.getElementById('loader');
const barfill = document.getElementById('barfill');
const pctEl = document.getElementById('pct');
const subEl = loaderEl ? loaderEl.querySelector('.sub') : null;

let scanGroup = null, cadGroup = null;   // Rhino: Layer "3D_Scan" vs. restliche Geometrie (CAD)

function setProgress(loaded, total) {
  if (total) { const p = Math.min(100, Math.round((loaded / total) * 100)); barfill.style.width = p + '%'; pctEl.innerHTML = p + '&nbsp;%'; }
  else { pctEl.innerHTML = (loaded / 1048576).toFixed(1) + '&nbsp;MB'; }
}
function loadError(msg) { console.error(msg); const e = document.getElementById('err'); e.style.display = 'block'; e.textContent = msg; }

// Unbeleuchtete, doppelseitige Materialien (Matterport: Licht ist gebacken)
function applyUnlit(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const conv = mats.map((m) => {
      if (!m) return m;
      const map = m.map || null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      const b = new THREE.MeshBasicMaterial({ map, color: map ? 0xffffff : (m.color || new THREE.Color(0xcccccc)), side: THREE.DoubleSide });
      m.dispose?.();
      return b;
    });
    o.material = Array.isArray(o.material) ? conv : conv[0];
  });
}

// Einfaches Daylight-Modell (Himmel + Sonne) für Rhino/CAD
function addDaylight() {
  scene.children.filter((o) => o.name === 'baselight').forEach((o) => scene.remove(o));
  scene.background = new THREE.Color(0xdfe7ef);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const hemi = new THREE.HemisphereLight(0xdfeaff, 0x9a8f80, 1.2); hemi.name = 'daylight';
  const sun = new THREE.DirectionalLight(0xfff3e2, 2.4); sun.position.set(8, 16, 6); sun.name = 'daylight';
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.5); fill.position.set(-10, 6, -8); fill.name = 'daylight';
  scene.add(hemi, sun, fill);
}

// Robuste Bounding-Box: ignoriert weit entfernte Ausreißer (z. B. 2D-Pläne,
// Planköpfe, Logos), die sonst die Start-Kamera extrem weit weg schieben.
function robustModelBox(root) {
  root.updateMatrixWorld(true);
  const centers = [], boxes = [];
  root.traverse((o) => {
    if (!o.isMesh || o.visible === false) return;     // ausgeblendete (Off-Layer) nicht mitrahmen
    const b = new THREE.Box3().setFromObject(o);
    if (!b.isEmpty()) { boxes.push(b); centers.push(b.getCenter(new THREE.Vector3())); }
  });
  if (boxes.length === 0) return new THREE.Box3().setFromObject(root);
  const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const mc = new THREE.Vector3(med(centers.map((c) => c.x)), med(centers.map((c) => c.y)), med(centers.map((c) => c.z)));
  const dist = centers.map((c) => c.distanceTo(mc)).sort((a, b) => a - b);
  const p75 = dist[Math.floor(dist.length * 0.75)] || 0;
  const thr = p75 * 1.5 + 1;
  const box = new THREE.Box3();
  boxes.forEach((b, i) => { if (centers[i].distanceTo(mc) <= thr) box.union(b); });
  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
}

function finishLoad(root) {
  model = root;
  model.updateMatrixWorld(true);
  scene.add(model);
  const box = robustModelBox(model);
  modelBox = box.clone();
  box.getCenter(modelCenter);
  const size = box.getSize(new THREE.Vector3());
  modelRadius = Math.max(size.x, size.y, size.z) * 0.5 || 5;
  const eyeHeight = box.min.y + Math.min(1.7, size.y * 0.5);
  home.pos.set(modelCenter.x + modelRadius * 0.85, eyeHeight + modelRadius * 0.45, modelCenter.z + modelRadius * 0.85);
  home.target.set(modelCenter.x, eyeHeight, modelCenter.z);
  baseSpeed = Math.max(0.6, modelRadius * 0.12);
  camera.near = Math.max(0.01, modelRadius * 0.002);
  camera.far = modelRadius * 60;
  camera.updateProjectionMatrix();
  resetView();
  loaderEl.classList.add('hidden');
  setTimeout(() => (loaderEl.style.display = 'none'), 700);
  renderer.domElement.focus();
  window.dispatchEvent(new CustomEvent('viewer-ready'));
}

// --- Standard-GLB / Matterport-GLB ---
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
const gltfLoader = new GLTFLoader(); gltfLoader.setDRACOLoader(draco);
function loadGLB(url) {
  litModel = false;
  gltfLoader.load(url, (g) => { const r = g.scene; r.rotateX(-Math.PI / 2); applyUnlit(r); finishLoad(r); },
    (x) => setProgress(x.loaded, x.lengthComputable ? x.total : 0),
    () => loadError('Fehler beim Laden des Modells. Bitte über HTTPS öffnen, nicht per Doppelklick.'));
}

// --- Matterport-ZIP (OBJ + Texturen direkt im Browser) ---
const baseName = (p) => p.split(/[\\/]/).pop().toLowerCase();
async function loadMatterportZip(url) {
  litModel = false;
  try {
    if (subEl) subEl.textContent = 'Lade & entpacke Scan …';
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || 0;
    const reader = res.body.getReader(); const chunks = []; let loaded = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); loaded += value.length; setProgress(loaded, total); }
    const JSZip = (await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm')).default;
    const zip = await JSZip.loadAsync(await new Blob(chunks).arrayBuffer());
    const files = Object.values(zip.files).filter((f) => !f.dir);
    const objFile = files.find((f) => f.name.toLowerCase().endsWith('.obj'));
    const mtlFile = files.find((f) => f.name.toLowerCase().endsWith('.mtl'));
    if (!objFile) throw new Error('Keine .obj-Datei im ZIP gefunden.');
    if (subEl) subEl.textContent = 'Lade Texturen …';
    const texUrls = {};
    for (const f of files) if (/\.(jpe?g|png)$/i.test(f.name)) texUrls[baseName(f.name)] = URL.createObjectURL(await f.async('blob'));
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => texUrls[baseName(u)] || u);
    let materials = null;
    if (mtlFile) { const mtl = new MTLLoader(manager).parse(await mtlFile.async('text'), ''); mtl.preload(); materials = mtl; }
    const objLoader = new OBJLoader(manager);
    if (materials) objLoader.setMaterials(materials);
    const root = objLoader.parse(await objFile.async('text'));
    root.rotateX(-Math.PI / 2);
    applyUnlit(root);
    finishLoad(root);
  } catch (e) { loadError('Matterport-ZIP konnte nicht geladen werden: ' + e.message); }
}

// --- Rhino .3dm ---
function loadRhino(url, has2d) {
  litModel = true;
  if (subEl) subEl.textContent = 'Lade Rhino-Modell …';
  addDaylight();
  const rl = new Rhino3dmLoader();
  rl.setLibraryPath('https://cdn.jsdelivr.net/npm/rhino3dm@8.4.0/');
  rl.load(url, (root) => {
    root.rotateX(-Math.PI / 2);
    postProcessRhino(root);
    if (has2d) splitByScanLayer(root);
    finishLoad(root);
    if (has2d && scanGroup) setupScanSwitch();
  }, (x) => setProgress(x.loaded, x.lengthComputable ? x.total : 0),
     () => loadError('Rhino-Datei (.3dm) konnte nicht geladen werden.'));
}

function rhinoLayerName(obj, layers) {
  const idx = obj.userData && obj.userData.attributes ? obj.userData.attributes.layerIndex : null;
  if (idx == null || !layers || !layers[idx]) return null;
  const l = layers[idx];
  return typeof l === 'string' ? l : (l.name || null);
}

function rhinoLayers(root) {
  return (root.userData && (root.userData.layers || (root.userData.document && root.userData.document.layers))) || null;
}

// Rhino-Nachbearbeitung:
//  - Linien/Kurven/Punkte NICHT zeichnen (z. B. Pläne/Planköpfe, Bemaßung)
//  - Glas-Material auf Layern, deren Name "glas"/"glass" enthält
function postProcessRhino(root) {
  const layers = rhinoLayers(root);
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xbfe0ee, metalness: 0, roughness: 0.06, transmission: 0.0,
    transparent: true, opacity: 0.26, side: THREE.DoubleSide, depthWrite: false,
  });
  const remove = [];
  root.traverse((o) => {
    if (o.isLine || o.isLineSegments || o.isPoints) { remove.push(o); return; }
    if (!o.isMesh) return;
    const idx = o.userData && o.userData.attributes ? o.userData.attributes.layerIndex : null;
    const layer = (layers && idx != null) ? layers[idx] : null;
    const name = layer ? (typeof layer === 'string' ? layer : (layer.name || '')) : '';
    const ln = name.toLowerCase();
    const isGlass = ln.includes('glas') || ln.includes('glaß');
    if (isGlass) {
      o.material = glassMat;
      o.userData.isGlass = true;
      o.renderOrder = 2;
    } else if (layer && layer.visible === false) {
      o.visible = false;          // Layer ist in Rhino ausgeblendet
    }
  });
  remove.forEach((o) => { if (o.parent) o.parent.remove(o); o.geometry && o.geometry.dispose(); });
}
function splitByScanLayer(root) {
  const layers = (root.userData && (root.userData.layers
    || (root.userData.document && root.userData.document.layers))) || null;
  scanGroup = new THREE.Group(); cadGroup = new THREE.Group();
  const sc = [], cd = [];
  root.traverse((o) => {
    if (!o.isMesh && !o.isLine && !o.isPoints) return;
    const n = rhinoLayerName(o, layers);
    (n && String(n).trim().toLowerCase() === '3d_scan' ? sc : cd).push(o);
  });
  sc.forEach((o) => scanGroup.attach(o));
  cd.forEach((o) => cadGroup.attach(o));
  root.add(scanGroup, cadGroup);
  cadGroup.visible = true; scanGroup.visible = false;     // Standard: CAD-Ansicht
  if (scanGroup.children.length === 0) scanGroup = null;   // kein Scan erkennbar -> kein Switch
}
function setupScanSwitch() {
  const topbar = document.getElementById('topbar');
  const sep = document.createElement('div'); sep.className = 'sep';
  const seg = document.createElement('div'); seg.className = 'seg'; seg.id = 'scan-switch';
  const ICN_CAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5l8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z"/><path d="M3.7 7.3l8.3 4.7 8.3-4.7M12 12v9.5"/></svg>`;
  const ICN_SCAN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h3l1.4-2h7.2L17 7h3v12H4z"/><circle cx="12" cy="13" r="3.4"/></svg>`;
  seg.innerHTML = `<button class="btn active" data-v="cad" data-tip="3D-Modell (CAD)" aria-label="CAD">${ICN_CAD}<span>CAD</span></button>
                   <button class="btn" data-v="scan" data-tip="3D-Scan" aria-label="Scan">${ICN_SCAN}<span>Scan</span></button>`;
  topbar.append(sep, seg);
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    const scan = b.dataset.v === 'scan';
    scanGroup.visible = scan; cadGroup.visible = !scan;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  }));
}

// --- Entscheiden, was geladen wird ---
function startLoad() {
  const pid = window.PROJECT_ID;
  if (!pid) { loadGLB('./model.glb'); return; }   // Standard-Projekt (Prinzenstraße)
  fetch(`${window.SUPABASE_URL}/rest/v1/projects?id=eq.${pid}&select=*`, {
    headers: { apikey: window.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + window.SUPABASE_ANON_KEY },
  }).then((r) => r.json()).then((rows) => {
    const p = rows && rows[0];
    if (!p) { loadError('Projekt nicht gefunden.'); return; }
    projectData = p;
    document.title = p.name + ' · 3D Rundgang';
    // Versions-Query bricht den CDN-/Browser-Cache nach einem Update auf
    const url = window.STORAGE_BASE + p.file_path + '?v=' + (p.version || 1);
    if (p.type === 'rhino') loadRhino(url, !!p.has_2d_scan);
    else loadMatterportZip(url);
  }).catch((e) => loadError('Projekt konnte nicht geladen werden: ' + e.message));
}
startLoad();

// ---------------------------------------------------------------------------
//  Orbit-Controls (für "Umkreisen"-Modus)
// ---------------------------------------------------------------------------
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.enabled = false;

// ---------------------------------------------------------------------------
//  Fly-Controls (Unity-Style: rechte Maustaste halten + WASD)
// ---------------------------------------------------------------------------
const keys = Object.create(null);
let looking = false;
let baseSpeed = 1.5;          // wird nach Laden an Modellgröße angepasst
let speedMult = 1.0;          // per Mausrad einstellbar
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

const dom = renderer.domElement;

dom.addEventListener('contextmenu', (e) => e.preventDefault());

dom.addEventListener('mousedown', (e) => {
  if (mode !== 'walk') return;
  if (e.button === 2) {                 // rechte Maustaste -> umsehen
    looking = true;
    document.body.classList.add('looking');
    dom.requestPointerLock?.();
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button === 2 && looking) {
    looking = false;
    document.body.classList.remove('looking');
    if (document.pointerLockElement) document.exitPointerLock();
  }
});

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && looking) {
    looking = false;
    document.body.classList.remove('looking');
  }
});

const PITCH_LIMIT = Math.PI / 2 - 0.01;
// zentraler Umsehen-Helfer (für Rechtsklick, Linksklick-Ziehen und Pfeiltasten)
function applyLook(dYaw, dPitch) {
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= dYaw;
  euler.x -= dPitch;
  euler.x = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, euler.x));
  camera.quaternion.setFromEuler(euler);
}

// Rechtsklick (Pointer-Lock): umsehen über movementX/Y
dom.addEventListener('mousemove', (e) => {
  if (!looking || mode !== 'walk') return;
  applyLook((e.movementX || 0) * 0.0022, (e.movementY || 0) * 0.0022);
});

// Linksklick gedrückt ziehen = umsehen (trackpad-/mausfrei-freundlich).
// Nur im Fly-Modus und wenn kein Platzierungs-Werkzeug aktiv ist.
let dragLook = null;
dom.addEventListener('pointerdown', (e) => {
  if (mode !== 'walk' || e.button !== 0) return;
  if (document.body.classList.contains('cmt-placing') || document.body.classList.contains('meas-measuring')) return;
  dragLook = { x: e.clientX, y: e.clientY };
});
window.addEventListener('pointermove', (e) => {
  if (!dragLook) return;
  const dx = e.clientX - dragLook.x, dy = e.clientY - dragLook.y;
  dragLook.x = e.clientX; dragLook.y = e.clientY;
  applyLook(dx * 0.004, dy * 0.004);
});
window.addEventListener('pointerup', () => { dragLook = null; });

// Mausrad -> Tempo (im Fly-Modus). Orbit nutzt das Rad selbst zum Zoomen.
dom.addEventListener('wheel', (e) => {
  if (mode !== 'walk') return;
  e.preventDefault();
  speedMult *= e.deltaY < 0 ? 1.12 : 0.89;
  speedMult = Math.max(0.1, Math.min(12, speedMult));
  document.getElementById('speedval').textContent = speedMult.toFixed(1);
}, { passive: false });

// Tastatureingaben in Textfeldern (Kommentare) dürfen die Kamera NICHT bewegen.
function isTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  keys[e.code] = true;
  if (e.code === 'KeyR') resetView();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---------------------------------------------------------------------------
//  Modus-Umschaltung & UI
// ---------------------------------------------------------------------------
const btnWalk = document.getElementById('mode-walk');
const btnOrbit = document.getElementById('mode-orbit');
const speedBadge = document.getElementById('speedbadge');

function setMode(m) {
  mode = m;
  const walk = m === 'walk';
  btnWalk.classList.toggle('active', walk);
  btnOrbit.classList.toggle('active', !walk);
  document.getElementById('hud-walk').style.display = walk ? '' : 'none';
  document.getElementById('hud-orbit').style.display = walk ? 'none' : '';
  speedBadge.style.display = walk ? '' : 'none';
  orbit.enabled = !walk;
  if (!walk) {
    orbit.target.copy(modelCenter);
    orbit.update();
  } else {
    renderer.domElement.focus();
  }
}
btnWalk.addEventListener('click', () => setMode('walk'));
btnOrbit.addEventListener('click', () => setMode('orbit'));

function resetView() {
  camera.position.copy(home.pos);
  camera.lookAt(home.target);
  speedMult = 1.0;
  document.getElementById('speedval').textContent = '1.0';
  if (mode === 'orbit') { orbit.target.copy(modelCenter); orbit.update(); }
}
document.getElementById('btn-reset').addEventListener('click', resetView);

// HUD ein-/ausklappen
const hud = document.getElementById('hud');
document.getElementById('hud-title').addEventListener('click', () => {
  hud.classList.toggle('collapsed');
  hud.querySelector('.toggle').textContent = hud.classList.contains('collapsed') ? 'anzeigen' : 'ausblenden';
});

// ---------------------------------------------------------------------------
//  API für das Kommentar-/Annotationsmodul (comments.js)
// ---------------------------------------------------------------------------
const up = new THREE.Vector3(0, 1, 0);
const _ray = new THREE.Raycaster();
const frameCallbacks = [];      // werden jeden Frame aufgerufen (Pins, Mess-Labels…)
let tween = null;               // sanftes Anfliegen einer Stelle
let renderHook = null;          // optionales Rendering (Postprocessing/Pfadtracer)
let cameraMoved = false;        // Kamera hat sich diesen Frame bewegt (für Pfadtracer)
const _prevCamPos = new THREE.Vector3();
const _prevCamQuat = new THREE.Quaternion();

// NDC (-1..1) -> Treffer auf dem Modell oder null
function raycastModel(ndcX, ndcY) {
  if (!model) return null;
  _ray.setFromCamera({ x: ndcX, y: ndcY }, camera);
  const hits = _ray.intersectObject(model, true);
  return hits.length ? hits[0] : null;
}

// 3D-Weltpunkt -> Bildschirmkoordinaten (px) + Sichtbarkeit
function worldToScreen(v) {
  const p = v.clone().project(camera);
  return {
    x: (p.x * 0.5 + 0.5) * window.innerWidth,
    y: (-p.y * 0.5 + 0.5) * window.innerHeight,
    behind: p.z > 1,
  };
}

// Ist der Punkt von der Kamera aus durch Geometrie verdeckt?
function isOccluded(point) {
  if (!model) return false;
  const dir = point.clone().sub(camera.position);
  const len = dir.length();
  if (len < 0.001) return false;
  dir.divideScalar(len);
  _ray.set(camera.position, dir);
  const hits = _ray.intersectObject(model, true);
  return hits.length > 0 && hits[0].distance < len - 0.18;
}

// Kamera sanft zu einer Stelle bewegen und sie anschauen
function flyTo(point) {
  const dist = Math.min(3.0, Math.max(1.2, modelRadius * 0.4));
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const toPos = point.clone().add(dir.multiplyScalar(-dist));
  const m = new THREE.Matrix4().lookAt(toPos, point, up);
  const toQuat = new THREE.Quaternion().setFromRotationMatrix(m);
  tween = {
    fromPos: camera.position.clone(), toPos,
    fromQuat: camera.quaternion.clone(), toQuat,
    target: point.clone(), t: 0, dur: 0.7,
  };
  if (mode === 'orbit') orbit.target.copy(point);
}

// Kamera-Pose (Position + Blickrichtung) erfassen / animiert anfliegen (Bookmarks)
function getPose() {
  return { pos: camera.position.clone(), quat: camera.quaternion.clone() };
}
function flyToPose(pos, quat, dur) {
  setMode('walk');
  tween = {
    fromPos: camera.position.clone(), toPos: pos.clone(),
    fromQuat: camera.quaternion.clone(), toQuat: quat.clone(),
    target: null, t: 0, dur: dur || 1.2,
  };
}

function updateTween(dt) {
  tween.t += dt / tween.dur;
  const x = Math.min(1, tween.t);
  const k = x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; // easeInOutQuad
  camera.position.lerpVectors(tween.fromPos, tween.toPos, k);
  camera.quaternion.slerpQuaternions(tween.fromQuat, tween.toQuat, k);
  if (tween.t >= 1) tween = null;
}

// Öffentliche Schnittstelle
window.viewer = {
  THREE, scene, camera, renderer, domElement: dom,
  getModel: () => model,
  isWalkMode: () => mode === 'walk',
  isLooking: () => looking,
  raycastModel, worldToScreen, isOccluded, flyTo, flyToPose, getPose,
  addFrameCallback: (fn) => { frameCallbacks.push(fn); },
  setFrameCallback: (fn) => { frameCallbacks.push(fn); }, // additiv (Rückwärtskompatibilität)
  isLit: () => litModel,
  getBounds: () => ({ center: modelCenter.clone(), radius: modelRadius, box: modelBox.clone() }),
  getProject: () => projectData,
  setRenderHook: (fn) => { renderHook = fn; },             // null = Standard-Rendering
  getCameraMoved: () => cameraMoved,                       // für Pfadtracer-Reset
};

// ---------------------------------------------------------------------------
//  Render-Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const move = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (tween) updateTween(dt);

  if (mode === 'walk' && model && !isTyping() && !tween) {
    let speed = baseSpeed * speedMult;
    if (keys['ShiftLeft'] || keys['ShiftRight']) speed *= 3.0;
    if (keys['ControlLeft'] || keys['ControlRight']) speed *= 0.3;

    // Pfeiltasten = umsehen (tastaturfreundlich, ohne Maus)
    const lr = 1.6 * dt;
    let dYaw = 0, dPitch = 0;
    if (keys['ArrowLeft']) dYaw -= lr;
    if (keys['ArrowRight']) dYaw += lr;
    if (keys['ArrowUp']) dPitch -= lr;
    if (keys['ArrowDown']) dPitch += lr;
    if (dYaw || dPitch) applyLook(dYaw, dPitch);

    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, up).normalize();
    move.set(0, 0, 0);

    if (keys['KeyW']) move.add(fwd);
    if (keys['KeyS']) move.sub(fwd);
    if (keys['KeyD']) move.add(right);
    if (keys['KeyA']) move.sub(right);
    if (keys['KeyE'] || keys['Space']) move.add(up);
    if (keys['KeyQ']) move.sub(up);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      camera.position.add(move);
    }
  } else if (mode === 'orbit' && !tween) {
    orbit.update();
  }

  cameraMoved = !_prevCamPos.equals(camera.position) || !_prevCamQuat.equals(camera.quaternion);
  _prevCamPos.copy(camera.position); _prevCamQuat.copy(camera.quaternion);

  for (let i = 0; i < frameCallbacks.length; i++) frameCallbacks[i]();
  if (renderHook) renderHook(dt); else renderer.render(scene, camera);
}
animate();

// ---------------------------------------------------------------------------
//  Resize
// ---------------------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
