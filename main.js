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
  },
  (xhr) => {
    if (xhr.lengthComputable) {
      const p = Math.round((xhr.loaded / xhr.total) * 100);
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

dom.addEventListener('mousemove', (e) => {
  if (!looking || mode !== 'walk') return;
  const dx = e.movementX || 0;
  const dy = e.movementY || 0;
  euler.setFromQuaternion(camera.quaternion);
  euler.y -= dx * 0.0022;
  euler.x -= dy * 0.0022;
  euler.x = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, euler.x));
  camera.quaternion.setFromEuler(euler);
});

// Mausrad -> Tempo (im Fly-Modus). Orbit nutzt das Rad selbst zum Zoomen.
dom.addEventListener('wheel', (e) => {
  if (mode !== 'walk') return;
  e.preventDefault();
  speedMult *= e.deltaY < 0 ? 1.12 : 0.89;
  speedMult = Math.max(0.1, Math.min(12, speedMult));
  document.getElementById('speedval').textContent = speedMult.toFixed(1);
}, { passive: false });

window.addEventListener('keydown', (e) => {
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
//  Render-Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();
const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const move = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);

  if (mode === 'walk' && model) {
    let speed = baseSpeed * speedMult;
    if (keys['ShiftLeft'] || keys['ShiftRight']) speed *= 3.0;
    if (keys['ControlLeft'] || keys['ControlRight']) speed *= 0.3;

    camera.getWorldDirection(fwd);
    right.crossVectors(fwd, up).normalize();
    move.set(0, 0, 0);

    if (keys['KeyW'] || keys['ArrowUp']) move.add(fwd);
    if (keys['KeyS'] || keys['ArrowDown']) move.sub(fwd);
    if (keys['KeyD'] || keys['ArrowRight']) move.add(right);
    if (keys['KeyA'] || keys['ArrowLeft']) move.sub(right);
    if (keys['KeyE'] || keys['Space']) move.add(up);
    if (keys['KeyQ']) move.sub(up);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed * dt);
      camera.position.add(move);
    }
  } else if (mode === 'orbit') {
    orbit.update();
  }

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
