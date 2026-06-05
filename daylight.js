// ===========================================================================
//  Daylight + Qualitätsstufen (nur für beleuchtete CAD-/Rhino-Projekte)
//  - Tageszeit & Norden -> Sonnenstand + Himmel (Sky)
//  - Qualität: Einfach · Mittel (Schatten+AO) · Hoch (Schatten+AO, hochauflösend) · Ultra (Pfadtracing)
//  - Einstellungen pro Projekt in Supabase gespeichert (projects.settings)
// ===========================================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
const CONFIGURED = typeof URL === 'string' && URL.startsWith('http') && KEY && KEY.length > 20;
const PID = window.PROJECT_ID || null;

const DEG = Math.PI / 180;
const DEFAULTS = { time: 14, north: 0, quality: 'mittel' };

let viewer, THREEref, scene, camera, renderer;
let sun, hemi, sky, ground;
let composer, ssaoPass;
let pathTracer = null, ptLoading = false;
let state = { ...DEFAULTS };
let bounds;

// ---------------------------------------------------------------------------
//  Styles + Panel
// ---------------------------------------------------------------------------
const css = document.createElement('style');
css.textContent = `
  #dl-panel { position:fixed; right:0; top:92px; width:280px; max-width:88vw; z-index:28;
    background:var(--mat-2); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border:1px solid var(--hairline); border-right:0; border-radius:18px 0 0 18px; box-shadow:var(--shadow);
    color:var(--label); font-family:var(--font); display:none; flex-direction:column; overflow:hidden; }
  #dl-panel.open { display:flex; }
  #dl-hd { display:flex; align-items:center; justify-content:space-between; padding:13px 15px; border-bottom:1px solid var(--hairline-soft); }
  #dl-hd h2 { font-size:15px; font-weight:700; }
  #dl-hd .min { cursor:pointer; color:var(--label3); font-size:20px; line-height:1; }
  #dl-hd .min:hover { color:var(--label); }
  #dl-body { padding:14px 15px; display:flex; flex-direction:column; gap:16px; }
  .dl-row label { display:flex; justify-content:space-between; font-size:12.5px; color:var(--label2); margin-bottom:8px; }
  .dl-row label b { color:var(--label); font-variant-numeric:tabular-nums; }
  .dl-row input[type=range] { width:100%; accent-color:var(--blue); }
  .dl-seg { display:flex; gap:2px; padding:2px; background:rgba(118,118,128,.22); border-radius:10px; }
  .dl-seg button { flex:1; background:transparent; border:0; color:var(--label2); border-radius:8px; padding:7px 4px;
    font:600 11.5px var(--font); cursor:pointer; transition:background .15s,color .15s; }
  .dl-seg button.on { background:rgba(120,120,128,.5); color:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); }
  #dl-qhint { font-size:11px; color:var(--label3); line-height:1.4; margin-top:6px; }
  #dl-save { background:var(--blue); border:0; color:#fff; border-radius:10px; padding:10px; font:600 13px var(--font); cursor:pointer; }
  #dl-save:hover { background:#0a76e6; }
  #dl-save.saved { background:var(--green); color:#04210f; }
  #dl-pt-status { position:fixed; left:50%; top:64px; transform:translateX(-50%); z-index:25;
    background:rgba(20,20,22,.82); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border:1px solid var(--hairline); color:var(--label); font:500 12px var(--font); padding:7px 14px; border-radius:var(--pill);
    box-shadow:var(--shadow); display:none; }
`;
document.head.appendChild(css);

const btn = document.createElement('button');
btn.className = 'btn';
btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg><span>Licht</span>`;
btn.dataset.tip = 'Licht & Qualität'; btn.setAttribute('aria-label', 'Licht & Qualität');

const panel = document.createElement('div');
panel.id = 'dl-panel';
panel.innerHTML = `
  <div id="dl-hd"><h2>☀️ Licht & Qualität</h2><span class="min" title="Minimieren">–</span></div>
  <div id="dl-body">
    <div class="dl-row">
      <label>Tageszeit <b id="dl-time-v">14:00</b></label>
      <input id="dl-time" type="range" min="0" max="24" step="0.25" value="14" />
    </div>
    <div class="dl-row">
      <label>Norden ausrichten <b id="dl-north-v">0°</b></label>
      <input id="dl-north" type="range" min="0" max="360" step="1" value="0" />
    </div>
    <div class="dl-row">
      <label>Qualität</label>
      <div class="dl-seg" id="dl-quality">
        <button data-q="einfach">Einfach</button>
        <button data-q="mittel">Mittel</button>
        <button data-q="hoch">Hoch</button>
        <button data-q="ultra">Ultra</button>
      </div>
      <div id="dl-qhint"></div>
    </div>
    <button id="dl-save">In Projekt speichern</button>
  </div>`;
const ptStatus = document.createElement('div');
ptStatus.id = 'dl-pt-status';

const QHINTS = {
  einfach: 'Nur Beleuchtung, keine Schatten. Am schnellsten.',
  mittel: 'Weiche Schatten + Ambient Occlusion (Screenspace).',
  hoch: 'Hochauflösende Schatten + AO. Architektur-Render-Look, flüssig.',
  ultra: 'Pfadtracing (echtes Raytracing). Baut sich progressiv auf – am besten für Standbilder; beim Bewegen unscharf.',
};

// ---------------------------------------------------------------------------
//  Sonnenstand
// ---------------------------------------------------------------------------
function sunDirection(time, northDeg) {
  const dayT = Math.max(0, Math.min(1, (time - 6) / 12));      // 0 bei 6h, 1 bei 18h
  const elev = Math.sin(dayT * Math.PI) * 62 * DEG;            // Höhe über Horizont
  const isDay = time > 6 && time < 18;
  const az = (90 + dayT * 180 + northDeg) * DEG;               // Ost→Süd→West (+ Norden)
  const cosE = Math.cos(elev);
  const dir = new THREE.Vector3(cosE * Math.sin(az), Math.max(0.02, Math.sin(elev)), cosE * Math.cos(az));
  return { dir: dir.normalize(), elev, isDay };
}

function applySun() {
  if (!sun) return;
  const c = bounds.center, r = bounds.radius;
  const { dir, elev, isDay } = sunDirection(state.time, state.north);
  sun.position.copy(c).add(dir.clone().multiplyScalar(r * 3));
  sun.target.position.copy(c);
  // Intensität/Farbe nach Höhe
  const e = Math.max(0, Math.min(1, elev / (62 * DEG)));
  if (isDay) {
    sun.intensity = 0.5 + e * 2.6;
    sun.color.setHSL(0.09 + e * 0.04, 0.55 - e * 0.3, 0.55 + e * 0.15); // warm->weiß
    hemi.intensity = 0.5 + e * 0.7;
    hemi.color.set(0xdfeaff); hemi.groundColor.set(0x9a8f80);
  } else {
    sun.intensity = 0.05; hemi.intensity = 0.3; hemi.color.set(0x4a5a7a); hemi.groundColor.set(0x202830);
  }
  // Himmel
  if (sky) {
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(dir);
    u.turbidity.value = 6; u.rayleigh.value = isDay ? 2 : 0.3;
    u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
  }
  if (pathTracer) try { pathTracer.updateLights ? pathTracer.updateLights() : null; resetPT(); } catch (e) {}
}

// ---------------------------------------------------------------------------
//  Qualität
// ---------------------------------------------------------------------------
function setupShadows(on, size) {
  renderer.shadowMap.enabled = on;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (sun) {
    sun.castShadow = on;
    sun.shadow.mapSize.set(size, size);
    const d = bounds.radius * 1.25;
    const cam = sun.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
    cam.near = 0.01; cam.far = bounds.radius * 8;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = bounds.radius * 0.002;
    cam.updateProjectionMatrix();
  }
  if (viewer.getModel()) viewer.getModel().traverse((o) => { if (o.isMesh) { o.castShadow = on; o.receiveShadow = on; } });
  if (ground) ground.visible = on;
}

function ensureComposer() {
  if (composer) return;
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  ssaoPass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
  ssaoPass.kernelRadius = Math.min(64, Math.max(8, bounds.radius * 0.02));
  ssaoPass.minDistance = 0.0008; ssaoPass.maxDistance = 0.12;
  composer.addPass(ssaoPass);
  composer.addPass(new OutputPass());
  composer.setSize(window.innerWidth, window.innerHeight);
}

async function setQuality(q) {
  state.quality = q;
  panel.querySelectorAll('#dl-quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === q));
  panel.querySelector('#dl-qhint').textContent = QHINTS[q] || '';
  disposePT();
  ptStatus.style.display = 'none';

  if (q === 'einfach') {
    setupShadows(false);
    viewer.setRenderHook(null);
  } else if (q === 'mittel') {
    setupShadows(true, 2048);
    ensureComposer();
    viewer.setRenderHook(() => composer.render());
  } else if (q === 'hoch') {
    setupShadows(true, 4096);
    ensureComposer();
    viewer.setRenderHook(() => composer.render());
  } else if (q === 'ultra') {
    setupShadows(true, 4096);
    await startPathTracer();
  }
  applySun();
}

// ---------------------------------------------------------------------------
//  Pfadtracer (Ultra) – best effort, mit Fallback
// ---------------------------------------------------------------------------
function resetPT() { if (pathTracer && pathTracer.updateCamera) pathTracer.updateCamera(); }
function disposePT() {
  if (pathTracer) { try { pathTracer.dispose && pathTracer.dispose(); } catch (e) {} pathTracer = null; }
}
async function startPathTracer() {
  if (ptLoading) return;
  ptLoading = true;
  ptStatus.textContent = 'Pfadtracer wird geladen …'; ptStatus.style.display = 'block';
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/three-gpu-pathtracer@0.0.23/build/index.module.js');
    const PT = mod.WebGLPathTracer;
    if (!PT) throw new Error('WebGLPathTracer nicht gefunden');
    pathTracer = new PT(renderer);
    pathTracer.renderScale = 0.75;
    pathTracer.setScene(scene, camera);
    viewer.setRenderHook(() => {
      if (!pathTracer) return;
      if (viewer.getCameraMoved()) pathTracer.updateCamera();
      pathTracer.renderSample();
      const s = Math.round(pathTracer.samples || 0);
      ptStatus.textContent = `Pfadtracing … ${s} Samples`;
      ptStatus.style.display = s > 64 ? 'none' : 'block';
    });
  } catch (e) {
    console.warn('[daylight] Pfadtracer nicht verfügbar, Fallback auf Hoch', e);
    ptStatus.textContent = 'Pfadtracer nicht verfügbar – nutze „Hoch".';
    setTimeout(() => (ptStatus.style.display = 'none'), 3000);
    state.quality = 'hoch';
    panel.querySelectorAll('#dl-quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === 'hoch'));
    ensureComposer(); viewer.setRenderHook(() => composer.render());
  } finally { ptLoading = false; }
}

// ---------------------------------------------------------------------------
//  Persistenz
// ---------------------------------------------------------------------------
let sb = null;
async function save() {
  if (!CONFIGURED || !PID) { alert('Speichern nur für hochgeladene Projekte möglich.'); return; }
  if (!sb) sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { error } = await sb.from('projects').update({ settings: { time: state.time, north: state.north, quality: state.quality } }).eq('id', PID);
  const b = panel.querySelector('#dl-save');
  if (error) { alert('Speichern fehlgeschlagen: ' + error.message); return; }
  b.textContent = 'Gespeichert ✓'; b.classList.add('saved');
  setTimeout(() => { b.textContent = 'In Projekt speichern'; b.classList.remove('saved'); }, 1800);
}

// ---------------------------------------------------------------------------
//  Setup
// ---------------------------------------------------------------------------
function buildRig() {
  // vorhandenes Basis-Daylight entfernen
  scene.children.filter((o) => o.name === 'daylight' || o.name === 'baselight').forEach((o) => scene.remove(o));
  scene.background = null;

  hemi = new THREE.HemisphereLight(0xdfeaff, 0x9a8f80, 1.0); scene.add(hemi);
  sun = new THREE.DirectionalLight(0xffffff, 2.0);
  scene.add(sun); scene.add(sun.target);

  sky = new Sky(); sky.scale.setScalar(Math.max(2000, bounds.radius * 100)); scene.add(sky);

  // Schatten-Auffangebene knapp unter dem Modell
  const g = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds.radius * 8, bounds.radius * 8),
    new THREE.ShadowMaterial({ opacity: 0.32 })
  );
  g.rotation.x = -Math.PI / 2;
  g.position.set(bounds.center.x, bounds.box.min.y - bounds.radius * 0.001, bounds.center.z);
  g.receiveShadow = true; ground = g; scene.add(g);

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
}

function wireUI() {
  document.getElementById('topbar').appendChild(btn);
  document.body.appendChild(panel);
  document.body.appendChild(ptStatus);

  const timeEl = panel.querySelector('#dl-time'), timeV = panel.querySelector('#dl-time-v');
  const northEl = panel.querySelector('#dl-north'), northV = panel.querySelector('#dl-north-v');
  const fmtTime = (t) => `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.round((t % 1) * 60)).padStart(2, '0')}`;

  function syncInputs() {
    timeEl.value = state.time; timeV.textContent = fmtTime(state.time);
    northEl.value = state.north; northV.textContent = Math.round(state.north) + '°';
  }
  timeEl.addEventListener('input', () => { state.time = +timeEl.value; timeV.textContent = fmtTime(state.time); applySun(); });
  northEl.addEventListener('input', () => { state.north = +northEl.value; northV.textContent = Math.round(state.north) + '°'; applySun(); });
  panel.querySelectorAll('#dl-quality button').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.q)));
  panel.querySelector('#dl-save').addEventListener('click', save);
  panel.querySelector('.min').addEventListener('click', () => { panel.classList.remove('open'); btn.classList.remove('active'); });
  btn.addEventListener('click', () => { const o = panel.classList.toggle('open'); btn.classList.toggle('active', o); });

  syncInputs();
}

function start() {
  viewer = window.viewer;
  if (!viewer.isLit || !viewer.isLit()) return;     // nur für CAD/Rhino
  THREEref = viewer.THREE; scene = viewer.scene; camera = viewer.camera; renderer = viewer.renderer;
  bounds = viewer.getBounds();

  // gespeicherte Einstellungen laden
  const proj = viewer.getProject && viewer.getProject();
  const s = (proj && proj.settings) || {};
  state = { time: typeof s.time === 'number' ? s.time : DEFAULTS.time, north: typeof s.north === 'number' ? s.north : DEFAULTS.north, quality: s.quality || DEFAULTS.quality };

  buildRig();
  wireUI();
  setQuality(state.quality);

  window.addEventListener('resize', () => { if (composer) composer.setSize(window.innerWidth, window.innerHeight); });
}

if (window.viewer && window.viewer.getModel && window.viewer.getModel()) start();
else window.addEventListener('viewer-ready', start, { once: true });
