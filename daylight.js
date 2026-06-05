// ===========================================================================
//  Daylight + Post-Processing (nur für beleuchtete CAD-/Rhino-Projekte)
//  - Tageszeit & Norden -> Sonnenstand + Himmel
//  - Voller Post-Processing-Stack (AO, Bloom, DoF, Vignette, Farbe, Tone-Mapping,
//    Kantenglättung, Filmkorn, Supersampling)
//  - Alle Einstellungen pro Projekt in Supabase gespeichert (projects.settings) -> für alle
// ===========================================================================
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { N8AOPass } from 'https://cdn.jsdelivr.net/npm/n8ao@1.9.4/+esm';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { BrightnessContrastShader } from 'three/addons/shaders/BrightnessContrastShader.js';
import { HueSaturationShader } from 'three/addons/shaders/HueSaturationShader.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
const CONFIGURED = typeof URL === 'string' && URL.startsWith('http') && KEY && KEY.length > 20;
const PID = window.PROJECT_ID || null;
const DEG = Math.PI / 180;

const TONEMAP = {
  none: THREE.NoToneMapping, linear: THREE.LinearToneMapping, reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping, aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping,
};

// Standard-/Default-Konfiguration
function defaults() {
  return {
    time: 14, north: 0,
    post: {
      shadows: true, shadowRes: 2048, supersample: 1, ambient: 0.25,
      ibl: true, iblIntensity: 1,
      ao: { on: true, radius: 30, intensity: 1.5 },
      bloom: { on: false, strength: 0.35, threshold: 0.85, radius: 0.4 },
      dof: { on: false, focus: 0, aperture: 2, maxblur: 0.01 },
      vignette: { on: false, amount: 1.0 },
      color: { brightness: 0, contrast: 0, saturation: 0 },
      tone: { mapping: 'aces', exposure: 0.9 },
      aa: 'smaa',
      film: { on: false, intensity: 0.3 },
    },
  };
}

let viewer, scene, camera, renderer, bounds;
let sun, hemi, sky, ground, amb;
let pmrem = null, envScene = null, envSky = null, envRT = null;
let composer = null;
let cfg = defaults();

// ---------------------------------------------------------------------------
//  Styles
// ---------------------------------------------------------------------------
const css = document.createElement('style');
css.textContent = `
  #dl-panel { position:fixed; right:0; top:92px; width:300px; max-width:90vw; max-height:calc(100vh - 120px); z-index:28;
    background:var(--mat-2); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border:1px solid var(--hairline); border-right:0; border-radius:18px 0 0 18px; box-shadow:var(--shadow);
    color:var(--label); font-family:var(--font); display:none; flex-direction:column; overflow:hidden; }
  #dl-panel.open { display:flex; }
  #dl-hd { display:flex; align-items:center; justify-content:space-between; padding:13px 15px; border-bottom:1px solid var(--hairline-soft); flex:0 0 auto; }
  #dl-hd h2 { font-size:15px; font-weight:700; }
  #dl-hd .min { cursor:pointer; color:var(--label3); font-size:20px; line-height:1; }
  #dl-hd .min:hover { color:var(--label); }
  #dl-body { padding:12px 15px; display:flex; flex-direction:column; gap:14px; overflow-y:auto; }
  .dl-sec { border-top:1px solid var(--hairline-soft); padding-top:12px; }
  .dl-sec:first-child { border-top:0; padding-top:0; }
  .dl-sec > .h { font-size:11px; font-weight:700; letter-spacing:.4px; text-transform:uppercase; color:var(--label3); margin-bottom:9px; }
  .dl-row { margin-bottom:9px; }
  .dl-row:last-child { margin-bottom:0; }
  .dl-row label { display:flex; justify-content:space-between; align-items:center; font-size:12.5px; color:var(--label2); margin-bottom:6px; }
  .dl-row label b { color:var(--label); font-variant-numeric:tabular-nums; font-weight:600; }
  .dl-row input[type=range] { width:100%; accent-color:var(--blue); }
  .dl-row select { width:100%; background:rgba(0,0,0,.3); border:1px solid var(--hairline); color:var(--label);
    border-radius:8px; padding:7px 9px; font:inherit; font-size:12.5px; outline:none; }
  .dl-tog { display:flex; align-items:center; justify-content:space-between; font-size:13px; color:var(--label); font-weight:600; cursor:pointer; }
  .dl-sw { position:relative; width:38px; height:22px; background:rgba(120,120,128,.4); border-radius:99px; transition:background .15s; flex:0 0 auto; }
  .dl-sw::after { content:""; position:absolute; top:2px; left:2px; width:18px; height:18px; background:#fff; border-radius:50%; transition:transform .18s; }
  .dl-tog.on .dl-sw { background:var(--blue); }
  .dl-tog.on .dl-sw::after { transform:translateX(16px); }
  .dl-sub { margin-top:9px; padding-left:2px; display:none; }
  .dl-tog.on + .dl-sub { display:block; }
  .dl-seg { display:flex; gap:2px; padding:2px; background:rgba(118,118,128,.22); border-radius:10px; }
  .dl-seg button { flex:1; background:transparent; border:0; color:var(--label2); border-radius:8px; padding:7px 4px;
    font:600 11.5px var(--font); cursor:pointer; }
  .dl-seg button.on { background:rgba(120,120,128,.5); color:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); }
  #dl-save { flex:0 0 auto; margin:0 15px 14px; background:var(--green); color:#04210f; border:0; border-radius:10px; padding:9px;
    font:600 12.5px var(--font); text-align:center; }
`;
document.head.appendChild(css);

// ---------------------------------------------------------------------------
//  Toolbar-Button + Panel
// ---------------------------------------------------------------------------
const btn = document.createElement('button');
btn.className = 'btn';
btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/></svg><span>Licht</span>`;
btn.dataset.tip = 'Licht, Qualität & Post-Processing'; btn.setAttribute('aria-label', 'Licht & Post-Processing');

function slider(id, label, min, max, step, val, unit) {
  return `<div class="dl-row"><label>${label} <b id="${id}-v"></b></label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-unit="${unit || ''}"/></div>`;
}
function toggle(id, label) {
  return `<div class="dl-tog" id="${id}-tog"><span>${label}</span><span class="dl-sw"></span></div>`;
}

const panel = document.createElement('div');
panel.id = 'dl-panel';
panel.innerHTML = `
  <div id="dl-hd"><h2>☀️ Licht & Post-Processing</h2><span class="min" title="Minimieren">–</span></div>
  <div id="dl-body">
    <div class="dl-sec">
      <div class="h">Sonne & Licht</div>
      ${slider('dl-time', 'Tageszeit', 0, 24, 0.25, 14, 'time')}
      ${slider('dl-north', 'Norden', 0, 360, 1, 0, '°')}
      ${slider('dl-ambient', 'Umgebungslicht', 0, 2, 0.05, 0.25, '')}
    </div>

    <div class="dl-sec">
      <div class="h">Voreinstellungen</div>
      <div class="dl-seg" id="dl-preset">
        <button data-q="einfach">Einfach</button><button data-q="mittel">Mittel</button>
        <button data-q="hoch">Hoch</button><button data-q="ultra">Ultra</button>
      </div>
    </div>

    <div class="dl-sec">
      <div class="h">Render</div>
      ${toggle('dl-shadows', 'Schatten')}
      <div class="dl-sub">
        <div class="dl-row"><label>Auflösung</label><select id="dl-shadowRes"><option value="1024">1024</option><option value="2048">2048</option><option value="4096">4096</option></select></div>
      </div>
      <div class="dl-row" style="margin-top:9px"><label>Supersampling</label><select id="dl-supersample"><option value="1">1× (schnell)</option><option value="1.5">1.5×</option><option value="2">2× (scharf)</option></select></div>
      <div style="height:9px"></div>
      ${toggle('dl-ibl', 'Umgebungsreflexionen (IBL)')}
      <div class="dl-sub">${slider('dl-ibl-int', 'Intensität', 0, 2, 0.05, 1, '')}</div>
    </div>

    <div class="dl-sec">
      <div class="h">Post-Processing</div>
      ${toggle('dl-ao', 'Ambient Occlusion')}<div class="dl-sub">
        ${slider('dl-ao-radius', 'Radius', 1, 120, 1, 30, '')}
        ${slider('dl-ao-intensity', 'Stärke', 0, 4, 0.1, 1.5, '')}</div>
      <div style="height:9px"></div>
      ${toggle('dl-bloom', 'Bloom (Leuchten)')}<div class="dl-sub">
        ${slider('dl-bloom-strength', 'Stärke', 0, 2, 0.05, 0.35, '')}
        ${slider('dl-bloom-threshold', 'Schwelle', 0, 1, 0.01, 0.85, '')}
        ${slider('dl-bloom-radius', 'Radius', 0, 1, 0.01, 0.4, '')}</div>
      <div style="height:9px"></div>
      ${toggle('dl-dof', 'Tiefenschärfe')}<div class="dl-sub">
        ${slider('dl-dof-focus', 'Fokus', 0, 100, 1, 30, '%')}
        ${slider('dl-dof-aperture', 'Blende', 0, 10, 0.1, 2, '')}</div>
      <div style="height:9px"></div>
      ${toggle('dl-vignette', 'Vignette')}<div class="dl-sub">${slider('dl-vignette-amount', 'Stärke', 0, 2, 0.05, 1, '')}</div>
      <div style="height:9px"></div>
      ${toggle('dl-film', 'Filmkorn')}<div class="dl-sub">${slider('dl-film-intensity', 'Intensität', 0, 1, 0.02, 0.3, '')}</div>
    </div>

    <div class="dl-sec">
      <div class="h">Farbe & Tone-Mapping</div>
      ${slider('dl-brightness', 'Helligkeit', -0.5, 0.5, 0.01, 0, '')}
      ${slider('dl-contrast', 'Kontrast', -0.5, 0.5, 0.01, 0, '')}
      ${slider('dl-saturation', 'Sättigung', -1, 1, 0.02, 0, '')}
      <div class="dl-row"><label>Tone-Mapping</label><select id="dl-tone">
        <option value="none">Aus</option><option value="linear">Linear</option><option value="reinhard">Reinhard</option>
        <option value="cineon">Cineon</option><option value="aces">ACES (Film)</option><option value="agx">AgX</option></select></div>
      ${slider('dl-exposure', 'Belichtung', 0.1, 2, 0.05, 0.9, '')}
    </div>

    <div class="dl-sec">
      <div class="h">Kantenglättung</div>
      <div class="dl-row"><select id="dl-aa"><option value="off">Aus</option><option value="fxaa">FXAA (schnell)</option><option value="smaa">SMAA (besser)</option></select></div>
    </div>
  </div>
  <button id="dl-save">Automatisch für alle gespeichert</button>`;

// ---------------------------------------------------------------------------
//  Sonne / Himmel
// ---------------------------------------------------------------------------
function sunDirection(time, northDeg) {
  const dayT = Math.max(0, Math.min(1, (time - 6) / 12));
  const elev = Math.sin(dayT * Math.PI) * 62 * DEG;
  const isDay = time > 6 && time < 18;
  const az = (90 + dayT * 180 + northDeg) * DEG;
  const cosE = Math.cos(elev);
  return { dir: new THREE.Vector3(cosE * Math.sin(az), Math.max(0.02, Math.sin(elev)), cosE * Math.cos(az)).normalize(), elev, isDay };
}
function applySun() {
  if (!sun) return;
  const c = bounds.center, r = bounds.radius;
  const { dir, elev, isDay } = sunDirection(cfg.time, cfg.north);
  sun.position.copy(c).add(dir.clone().multiplyScalar(r * 3));
  sun.target.position.copy(c);
  const e = Math.max(0, Math.min(1, elev / (62 * DEG)));
  if (isDay) {
    sun.intensity = 0.5 + e * 2.6;
    sun.color.setHSL(0.09 + e * 0.04, 0.55 - e * 0.3, 0.55 + e * 0.15);
    hemi.intensity = 0.5 + e * 0.7; hemi.color.set(0xdfeaff); hemi.groundColor.set(0x9a8f80);
  } else {
    sun.intensity = 0.05; hemi.intensity = 0.3; hemi.color.set(0x4a5a7a); hemi.groundColor.set(0x202830);
  }
  if (sky) {
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(dir); u.turbidity.value = 6; u.rayleigh.value = isDay ? 2 : 0.3;
    u.mieCoefficient.value = 0.005; u.mieDirectionalG.value = 0.8;
  }
}

// ---------------------------------------------------------------------------
//  Render-Anwendung
// ---------------------------------------------------------------------------
function applyShadows() {
  const p = cfg.post;
  renderer.shadowMap.enabled = p.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  if (sun) {
    sun.castShadow = p.shadows;
    sun.shadow.mapSize.set(p.shadowRes, p.shadowRes);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    const d = bounds.radius * 1.25, cam = sun.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d; cam.near = 0.01; cam.far = bounds.radius * 8;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = bounds.radius * 0.002; cam.updateProjectionMatrix();
  }
  if (viewer.getModel()) viewer.getModel().traverse((o) => { if (o.isMesh) { o.castShadow = p.shadows && !o.userData.isGlass; o.receiveShadow = p.shadows; } });
  if (ground) ground.visible = p.shadows;
}
function applyTone() {
  renderer.toneMapping = TONEMAP[cfg.post.tone.mapping] ?? THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = cfg.post.tone.exposure;
}
function applySupersample() {
  const pr = Math.min((window.devicePixelRatio || 1) * cfg.post.supersample, 3);
  renderer.setPixelRatio(pr);
}

function buildComposer() {
  if (composer) { composer.dispose && composer.dispose(); composer = null; }
  const p = cfg.post;
  const w = window.innerWidth, h = window.innerHeight;
  const colorActive = p.color.brightness !== 0 || p.color.contrast !== 0 || p.color.saturation !== 0;
  const need = p.ao.on || p.bloom.on || p.dof.on || p.vignette.on || p.film.on || colorActive || p.aa !== 'off';
  if (!need) { viewer.setRenderHook(null); return; }

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));

  if (p.ao.on) {
    const ao = new N8AOPass(scene, camera, w, h);
    ao.configuration.aoRadius = p.ao.radius;
    ao.configuration.intensity = p.ao.intensity;
    ao.configuration.distanceFalloff = 1;
    ao.configuration.gammaCorrection = false;   // OutputPass übernimmt Farbraum/Tone
    composer.addPass(ao);
  }
  if (p.dof.on) {
    const dist = bounds.radius * 2 * (p.dof.focus / 100) + bounds.radius * 0.2;
    composer.addPass(new BokehPass(scene, camera, { focus: dist, aperture: p.dof.aperture * 0.0001, maxblur: 0.01 }));
  }
  if (p.bloom.on) {
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), p.bloom.strength, p.bloom.radius, p.bloom.threshold));
  }
  composer.addPass(new OutputPass());        // Tone-Mapping + Farbraum

  if (colorActive) {
    const bc = new ShaderPass(BrightnessContrastShader);
    bc.uniforms.brightness.value = p.color.brightness; bc.uniforms.contrast.value = p.color.contrast;
    composer.addPass(bc);
    if (p.color.saturation !== 0) { const hs = new ShaderPass(HueSaturationShader); hs.uniforms.saturation.value = p.color.saturation; composer.addPass(hs); }
  }
  if (p.vignette.on) {
    const vg = new ShaderPass(VignetteShader); vg.uniforms.darkness.value = p.vignette.amount; vg.uniforms.offset.value = 1.0;
    composer.addPass(vg);
  }
  if (p.film.on) composer.addPass(new FilmPass(p.film.intensity, false));
  if (p.aa === 'fxaa') { const fx = new ShaderPass(FXAAShader); fx.uniforms.resolution.value.set(1 / (w * renderer.getPixelRatio()), 1 / (h * renderer.getPixelRatio())); composer.addPass(fx); }
  else if (p.aa === 'smaa') composer.addPass(new SMAAPass(w * renderer.getPixelRatio(), h * renderer.getPixelRatio()));

  viewer.setRenderHook(() => composer.render());
}

function applyAmbient() { if (amb) amb.intensity = cfg.post.ambient; }

// IBL: Umgebungskarte aus dem aktuellen Himmel erzeugen -> Reflexionen + Fülllicht
function updateEnvironment() {
  if (!pmrem) return;
  if (!cfg.post.ibl) { scene.environment = null; return; }
  const su = sky.material.uniforms, eu = envSky.material.uniforms;
  eu.sunPosition.value.copy(su.sunPosition.value);
  eu.turbidity.value = su.turbidity.value; eu.rayleigh.value = su.rayleigh.value;
  eu.mieCoefficient.value = su.mieCoefficient.value; eu.mieDirectionalG.value = su.mieDirectionalG.value;
  if (envRT) envRT.dispose();
  envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
  scene.environment = envRT.texture;
}
function applyEnvIntensity() {
  const v = cfg.post.ibl ? cfg.post.iblIntensity : 0;
  const m = viewer.getModel(); if (!m) return;
  m.traverse((o) => {
    if (!o.isMesh) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((mat) => { if (mat && 'envMapIntensity' in mat) mat.envMapIntensity = v; });
  });
}
function applyAll() {
  applyTone(); applyShadows(); applySupersample(); applyAmbient();
  applySun(); updateEnvironment(); applyEnvIntensity();
  buildComposer();
}

// ---------------------------------------------------------------------------
//  Presets
// ---------------------------------------------------------------------------
function preset(q) {
  const p = cfg.post;
  if (q === 'einfach') { p.shadows = false; p.ao.on = false; p.bloom.on = false; p.dof.on = false; p.vignette.on = false; p.film.on = false; p.aa = 'off'; p.supersample = 1; }
  else if (q === 'mittel') { p.shadows = true; p.shadowRes = 2048; p.ao.on = true; p.bloom.on = false; p.aa = 'smaa'; p.supersample = 1; }
  else if (q === 'hoch') { p.shadows = true; p.shadowRes = 2048; p.ao.on = true; p.ao.radius = 24; p.bloom.on = true; p.bloom.strength = 0.25; p.vignette.on = true; p.vignette.amount = 0.8; p.aa = 'smaa'; p.supersample = 1; }
  else if (q === 'ultra') { p.shadows = true; p.shadowRes = 2048; p.ao.on = true; p.ao.radius = 28; p.bloom.on = true; p.bloom.strength = 0.3; p.vignette.on = true; p.vignette.amount = 0.9; p.aa = 'smaa'; p.supersample = 1.5; }
  writeInputs(); applyAll(); autosave();
}

// ---------------------------------------------------------------------------
//  UI <-> Config
// ---------------------------------------------------------------------------
const $ = (id) => panel.querySelector('#' + id);
const fmtTime = (t) => `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.round((t % 1) * 60)).padStart(2, '0')}`;

function setTog(id, on) { $(id + '-tog').classList.toggle('on', !!on); }
function setSlider(id, v, unit) { const el = $(id); if (!el) return; el.value = v; const vv = $(id + '-v'); if (vv) vv.textContent = unit === 'time' ? fmtTime(v) : (Math.round(v * 100) / 100) + (unit || ''); }

function writeInputs() {
  const p = cfg.post;
  setSlider('dl-time', cfg.time, 'time'); setSlider('dl-north', cfg.north, '°'); setSlider('dl-ambient', p.ambient, '');
  setTog('dl-shadows', p.shadows); $('dl-shadowRes').value = String(p.shadowRes); $('dl-supersample').value = String(p.supersample);
  setTog('dl-ibl', p.ibl); setSlider('dl-ibl-int', p.iblIntensity, '');
  setTog('dl-ao', p.ao.on); setSlider('dl-ao-radius', p.ao.radius, ''); setSlider('dl-ao-intensity', p.ao.intensity, '');
  setTog('dl-bloom', p.bloom.on); setSlider('dl-bloom-strength', p.bloom.strength, ''); setSlider('dl-bloom-threshold', p.bloom.threshold, ''); setSlider('dl-bloom-radius', p.bloom.radius, '');
  setTog('dl-dof', p.dof.on); setSlider('dl-dof-focus', p.dof.focus, '%'); setSlider('dl-dof-aperture', p.dof.aperture, '');
  setTog('dl-vignette', p.vignette.on); setSlider('dl-vignette-amount', p.vignette.amount, '');
  setTog('dl-film', p.film.on); setSlider('dl-film-intensity', p.film.intensity, '');
  setSlider('dl-brightness', p.color.brightness, ''); setSlider('dl-contrast', p.color.contrast, ''); setSlider('dl-saturation', p.color.saturation, '');
  $('dl-tone').value = p.tone.mapping; setSlider('dl-exposure', p.tone.exposure, '');
  $('dl-aa').value = p.aa;
}
function readInputs() {
  const p = cfg.post;
  cfg.time = +$('dl-time').value; cfg.north = +$('dl-north').value; p.ambient = +$('dl-ambient').value;
  p.shadows = $('dl-shadows-tog').classList.contains('on'); p.shadowRes = +$('dl-shadowRes').value; p.supersample = +$('dl-supersample').value;
  p.ibl = $('dl-ibl-tog').classList.contains('on'); p.iblIntensity = +$('dl-ibl-int').value;
  p.ao.on = $('dl-ao-tog').classList.contains('on'); p.ao.radius = +$('dl-ao-radius').value; p.ao.intensity = +$('dl-ao-intensity').value;
  p.bloom.on = $('dl-bloom-tog').classList.contains('on'); p.bloom.strength = +$('dl-bloom-strength').value; p.bloom.threshold = +$('dl-bloom-threshold').value; p.bloom.radius = +$('dl-bloom-radius').value;
  p.dof.on = $('dl-dof-tog').classList.contains('on'); p.dof.focus = +$('dl-dof-focus').value; p.dof.aperture = +$('dl-dof-aperture').value;
  p.vignette.on = $('dl-vignette-tog').classList.contains('on'); p.vignette.amount = +$('dl-vignette-amount').value;
  p.film.on = $('dl-film-tog').classList.contains('on'); p.film.intensity = +$('dl-film-intensity').value;
  p.color.brightness = +$('dl-brightness').value; p.color.contrast = +$('dl-contrast').value; p.color.saturation = +$('dl-saturation').value;
  p.tone.mapping = $('dl-tone').value; p.tone.exposure = +$('dl-exposure').value;
  p.aa = $('dl-aa').value;
}

let rebuildTimer = null;
function onChange() {
  readInputs(); writeInputs();          // Labels aktualisieren
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => { applyAll(); }, 80);
  autosave();
}

function wireUI() {
  document.getElementById('topbar').appendChild(btn);
  document.body.appendChild(panel);
  btn.addEventListener('click', () => { const o = panel.classList.toggle('open'); btn.classList.toggle('active', o); });
  panel.querySelector('.min').addEventListener('click', () => { panel.classList.remove('open'); btn.classList.remove('active'); });
  // Schieber & Selects
  panel.querySelectorAll('input[type=range], select').forEach((el) => el.addEventListener('input', onChange));
  // Toggles
  panel.querySelectorAll('.dl-tog').forEach((t) => t.addEventListener('click', () => { t.classList.toggle('on'); onChange(); }));
  // Presets
  panel.querySelectorAll('#dl-preset button').forEach((b) => b.addEventListener('click', () => preset(b.dataset.q)));
  $('dl-save').addEventListener('click', () => autosave(true));
}

// ---------------------------------------------------------------------------
//  Persistenz (für alle)
// ---------------------------------------------------------------------------
let sb = null, saveTimer = null;
async function persist() {
  if (!CONFIGURED || !PID) return false;
  if (!sb) sb = createClient(URL, KEY, { auth: { persistSession: false } });
  const { error } = await sb.from('projects').update({ settings: { time: cfg.time, north: cfg.north, post: cfg.post } }).eq('id', PID);
  return !error;
}
function autosave() {
  const b = $('dl-save'); clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { if (await persist()) { b.textContent = 'Für alle gespeichert ✓'; setTimeout(() => (b.textContent = 'Automatisch für alle gespeichert'), 1500); } }, 600);
}

// ---------------------------------------------------------------------------
//  Rig + Start
// ---------------------------------------------------------------------------
function buildRig() {
  scene.children.filter((o) => o.name === 'daylight' || o.name === 'baselight').forEach((o) => scene.remove(o));
  scene.background = null;
  hemi = new THREE.HemisphereLight(0xdfeaff, 0x9a8f80, 1.0); scene.add(hemi);
  amb = new THREE.AmbientLight(0xffffff, cfg.post.ambient); scene.add(amb);
  sun = new THREE.DirectionalLight(0xffffff, 2.0); scene.add(sun); scene.add(sun.target);
  sky = new Sky(); sky.scale.setScalar(Math.max(2000, bounds.radius * 100)); scene.add(sky);
  // IBL: separater Himmel + PMREM-Generator für Umgebungsreflexionen
  envScene = new THREE.Scene(); envSky = new Sky(); envSky.scale.setScalar(100); envScene.add(envSky);
  pmrem = new THREE.PMREMGenerator(renderer); pmrem.compileEquirectangularShader();
  const g = new THREE.Mesh(new THREE.PlaneGeometry(bounds.radius * 8, bounds.radius * 8), new THREE.ShadowMaterial({ opacity: 0.32 }));
  g.rotation.x = -Math.PI / 2; g.position.set(bounds.center.x, bounds.box.min.y - bounds.radius * 0.001, bounds.center.z);
  g.receiveShadow = true; ground = g; scene.add(g);
}

function start() {
  viewer = window.viewer;
  if (!viewer.isLit || !viewer.isLit()) return;
  scene = viewer.scene; camera = viewer.camera; renderer = viewer.renderer; bounds = viewer.getBounds();

  // gespeicherte Einstellungen laden (für alle gleich)
  const proj = viewer.getProject && viewer.getProject();
  const s = (proj && proj.settings) || {};
  cfg = defaults();
  if (typeof s.time === 'number') cfg.time = s.time;
  if (typeof s.north === 'number') cfg.north = s.north;
  if (s.post && typeof s.post === 'object') cfg.post = Object.assign(defaults().post, s.post, {
    ao: { ...defaults().post.ao, ...(s.post.ao || {}) },
    bloom: { ...defaults().post.bloom, ...(s.post.bloom || {}) },
    dof: { ...defaults().post.dof, ...(s.post.dof || {}) },
    vignette: { ...defaults().post.vignette, ...(s.post.vignette || {}) },
    color: { ...defaults().post.color, ...(s.post.color || {}) },
    tone: { ...defaults().post.tone, ...(s.post.tone || {}) },
  });

  buildRig();
  wireUI();
  writeInputs();
  applyAll();
  window.addEventListener('resize', () => { if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(window.innerWidth, window.innerHeight); } });
}

if (window.viewer && window.viewer.getModel && window.viewer.getModel()) start();
else window.addEventListener('viewer-ready', start, { once: true });
