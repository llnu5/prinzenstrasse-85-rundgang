import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
scene.add(new THREE.HemisphereLight(0xffffff, 0x404550, 2.2));
const dir = new THREE.DirectionalLight(0xffffff, 1.1);
dir.position.set(5, 12, 8);
scene.add(dir);
const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
dir2.position.set(-8, 6, -6);
scene.add(dir2);

// ---------------------------------------------------------------------------
//  Zustand
// ---------------------------------------------------------------------------
let model = null;
let modelCenter = new THREE.Vector3();
let modelRadius = 10;
const home = { pos: new THREE.Vector3(), target: new THREE.Vector3() };
let mode = 'walk';            // 'walk' | 'orbit'

// ---------------------------------------------------------------------------
//  Modell laden
// ---------------------------------------------------------------------------
const draco = new DRACOLoader();
draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
const loader = new GLTFLoader();
loader.setDRACOLoader(draco);

const loaderEl = document.getElementById('loader');
const barfill = document.getElementById('barfill');
const pctEl = document.getElementById('pct');

loader.load(
  './model.glb',
  (gltf) => {
    model = gltf.scene;

    // Matterport-Modelle liegen oft mit Z nach oben -> auf Y-up drehen.
    model.rotateX(-Math.PI / 2);
    model.updateMatrixWorld(true);

    // Matterport-Texturen sind fotografisch "gebacken" (Licht steckt schon im
    // Bild). Daher: UNBELEUCHTETE (MeshBasic) + DOPPELSEITIGE Materialien.
    // -> jede Fläche zeigt ihr Foto in voller Helligkeit, keine schwarzen
    //    Stellen durch Beleuchtung oder Backface-Culling.
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const converted = mats.map((m) => {
        if (!m) return m;
        const map = m.map || null;
        if (map) map.colorSpace = THREE.SRGBColorSpace;
        const basic = new THREE.MeshBasicMaterial({
          map,
          color: map ? 0xffffff : (m.color || new THREE.Color(0xcccccc)),
          side: THREE.DoubleSide,
        });
        m.dispose?.();
        return basic;
      });
      o.material = Array.isArray(o.material) ? converted : converted[0];
    });

    scene.add(model);

    // Bounding-Box -> Kamera sinnvoll platzieren
    const box = new THREE.Box3().setFromObject(model);
    box.getCenter(modelCenter);
    const size = box.getSize(new THREE.Vector3());
    modelRadius = Math.max(size.x, size.y, size.z) * 0.5;

    // Startposition: erhöhte 3/4-Übersicht von außen, Blick zur Mitte.
    // Zuverlässig schön; von hier fliegt man mit WASD in die Räume.
    const eyeHeight = box.min.y + Math.min(1.7, size.y * 0.5);
    home.pos.set(modelCenter.x + modelRadius * 0.85, eyeHeight + modelRadius * 0.45, modelCenter.z + modelRadius * 0.85);
    home.target.set(modelCenter.x, eyeHeight, modelCenter.z);

    baseSpeed = Math.max(0.6, modelRadius * 0.12);
    camera.far = modelRadius * 40;
    camera.updateProjectionMatrix();

    resetView();

    loaderEl.classList.add('hidden');
    setTimeout(() => (loaderEl.style.display = 'none'), 700);
    renderer.domElement.focus();

    // Kommentar-Modul informieren, dass Modell & API bereit sind
    window.dispatchEvent(new CustomEvent('viewer-ready'));
  },
  (xhr) => {
    if (xhr.lengthComputable) {
      const p = Math.min(100, Math.round((xhr.loaded / xhr.total) * 100));
      barfill.style.width = p + '%';
      pctEl.innerHTML = p + '&nbsp;%';
    } else {
      pctEl.innerHTML = (xhr.loaded / 1048576).toFixed(1) + '&nbsp;MB';
    }
  },
  (err) => {
    console.error(err);
    const e = document.getElementById('err');
    e.style.display = 'block';
    e.textContent = 'Fehler beim Laden des Modells (model.glb). Bitte über einen Webserver/HTTPS öffnen, nicht per Doppelklick.';
  }
);

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

  for (let i = 0; i < frameCallbacks.length; i++) frameCallbacks[i]();
  renderer.render(scene, camera);
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
