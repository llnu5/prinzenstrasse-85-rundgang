// ===========================================================================
//  Messwerkzeug – zwei Punkte im 3D-Modell klicken -> Linie + Maß (Meter)
//  Dauerhaft gespeichert & in Echtzeit für alle Besucher sichtbar (Supabase).
// ===========================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = window.SUPABASE_URL;
const KEY = window.SUPABASE_ANON_KEY;
const CONFIGURED = typeof URL === 'string' && URL.startsWith('http') && typeof KEY === 'string' && KEY.length > 20;

const PID = window.PROJECT_ID || null;
const scope = (q) => (PID ? q.eq('project_id', PID) : q.is('project_id', null));
const inProject = (row) => ((row && row.project_id) || null) === PID;

const LINE_COLOR = 0x00e5ff;
const SPHERE_R = 0.045;          // Endpunkt-Radius in Metern

// ---------------------------------------------------------------------------
//  Styles
// ---------------------------------------------------------------------------
const css = document.createElement('style');
css.textContent = `
  #meas-labels { position: fixed; inset: 0; z-index: 17; pointer-events: none; overflow: hidden; }
  .meas-label {
    position: absolute; transform: translate(-50%, -50%); pointer-events: auto;
    background: rgba(20,20,22,.78); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
    color: #fff; border: 1px solid rgba(100,210,255,.55);
    border-radius: 8px; padding: 3px 7px 3px 10px; font: 600 12.5px var(--font); font-variant-numeric: tabular-nums;
    white-space: nowrap; box-shadow: 0 4px 14px rgba(0,0,0,.45); display: flex; align-items: center; gap: 7px;
    user-select: none; will-change: left, top;
  }
  .meas-label .del { cursor: pointer; color: var(--label3); font-size: 15px; line-height: 1;
    border-left: 1px solid rgba(255,255,255,.18); padding-left: 7px; transition: color .15s; }
  .meas-label .del:hover { color: var(--red); }
  .meas-label.preview { background: rgba(20,20,22,.7); border-style: dashed; border-color: rgba(255,255,255,.4); }
  body.meas-measuring #app, body.meas-measuring canvas { cursor: crosshair !important; }
  #meas-hint { position: fixed; top: 68px; left: 50%; transform: translateX(-50%); z-index: 25;
    background: rgba(100,210,255,.92); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
    color: #04222b; padding: 9px 18px; border-radius: var(--pill); font: 600 13px var(--font);
    box-shadow: var(--shadow); display: none; pointer-events: none; }
  body.meas-measuring #meas-hint { display: block; }
`;
document.head.appendChild(css);

const topbar = document.getElementById('topbar');
const btnMeasure = document.createElement('button');
btnMeasure.className = 'btn';
btnMeasure.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="8" width="19" height="8" rx="1.6"/><path d="M7 8v3M11 8v4.2M15 8v3M19 8v4.2"/></svg><span>Measure</span>`;
btnMeasure.dataset.tip = 'Measure'; btnMeasure.setAttribute('aria-label', 'Measure distance');
topbar.appendChild(btnMeasure);

const labelsEl = document.createElement('div');
labelsEl.id = 'meas-labels';
document.body.appendChild(labelsEl);

const hint = document.createElement('div');
hint.id = 'meas-hint';
hint.textContent = 'Click 2 points on the model to measure the distance · Esc cancels';
document.body.appendChild(hint);

// ---------------------------------------------------------------------------
//  Zustand
// ---------------------------------------------------------------------------
let viewer = null, THREE = null, sb = null;
const items = new Map();         // id -> {id, a, b, author, line, sa, sb, label}
let measuring = false;
let firstPoint = null;           // Vector3 des ersten Punkts (Messung in Arbeit)
let firstSphere = null;
let previewLine = null, previewLabel = null;
let lastNDC = null;              // letzte Mausposition über dem Canvas
let curMode = null;              // aktueller Scan-View-Modus: null=kein Switch | 'cad' | 'scan'
const visibleFor = (it) => !curMode || !it.view || it.view === curMode;   // ohne Switch / ohne Tag -> immer sichtbar

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function fmt(d) { return d >= 1 ? d.toFixed(2) + ' m' : Math.round(d * 100) + ' cm'; }
function lineMat(color, dashed) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity: dashed ? 0.7 : 0.95, depthTest: false });
}
function makeLine(a, b, color) {
  const g = new THREE.BufferGeometry().setFromPoints([a, b]);
  const l = new THREE.Line(g, lineMat(color));
  l.renderOrder = 999;
  viewer.scene.add(l);
  return l;
}
function makeSphere(p) {
  const s = new THREE.Mesh(
    new THREE.SphereGeometry(SPHERE_R, 16, 12),
    new THREE.MeshBasicMaterial({ color: LINE_COLOR, depthTest: false })
  );
  s.renderOrder = 1000;
  s.position.copy(p);
  viewer.scene.add(s);
  return s;
}
function disposeObj(o) {
  if (!o) return;
  viewer.scene.remove(o);
  o.geometry && o.geometry.dispose();
  o.material && o.material.dispose();
}

// ---------------------------------------------------------------------------
//  Supabase
// ---------------------------------------------------------------------------
async function initBackend() {
  if (!CONFIGURED) { btnMeasure.title = 'Backend not configured (config.js)'; return; }
  sb = createClient(URL, KEY, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 5 } } });
  const { data, error } = await scope(sb.from('measurements').select('*')).order('created_at');
  if (error) { console.error('[measure] load', error); return; }
  for (const r of data) addItem(r);
  sb.channel('mess')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'measurements' }, (p) => {
      if (!inProject(p.new) && !inProject(p.old)) return;
      if (p.eventType === 'INSERT') addItem(p.new);
      else if (p.eventType === 'DELETE') removeItem(p.old.id);
    })
    .subscribe();
}

async function createMeasurement(a, b) {
  const author = localStorage.getItem('cmt_name') || 'Guest';
  const row = { author, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, project_id: PID, view: curMode };
  const { data, error } = await sb.from('measurements').insert(row).select().single();
  if (error) { alert('Could not save measurement: ' + error.message); return; }
  addItem(data);
}
async function deleteMeasurement(id) {
  removeItem(id);
  if (sb) await sb.from('measurements').delete().eq('id', id);
}

// ---------------------------------------------------------------------------
//  Rendering der gespeicherten Messungen
// ---------------------------------------------------------------------------
function addItem(r) {
  if (items.has(r.id)) return;
  const a = new THREE.Vector3(r.ax, r.ay, r.az);
  const b = new THREE.Vector3(r.bx, r.by, r.bz);
  const line = makeLine(a, b, LINE_COLOR);
  const sa = makeSphere(a), sbp = makeSphere(b);
  const label = document.createElement('div');
  label.className = 'meas-label';
  label.innerHTML = `<span class="val">${fmt(a.distanceTo(b))}</span><span class="del" title="Delete measurement">×</span>`;
  label.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); deleteMeasurement(r.id); });
  labelsEl.appendChild(label);
  items.set(r.id, { id: r.id, a, b, author: r.author, line, sa, sb: sbp, label, view: r.view || null });
}
function removeItem(id) {
  const it = items.get(id);
  if (!it) return;
  disposeObj(it.line); disposeObj(it.sa); disposeObj(it.sb);
  it.label.remove();
  items.delete(id);
}

// ---------------------------------------------------------------------------
//  Frame-Update: Labels positionieren + Vorschau
// ---------------------------------------------------------------------------
let _midV = null;
function frame() {
  if (!viewer) return;
  if (!_midV) _midV = new THREE.Vector3();
  for (const it of items.values()) {
    const vis = visibleFor(it);                       // nur im passenden Modus (CAD/Scan) zeigen
    it.line.visible = vis; it.sa.visible = vis; it.sb.visible = vis;
    if (!vis) { it.label.style.display = 'none'; continue; }
    _midV.set((it.a.x + it.b.x) / 2, (it.a.y + it.b.y) / 2, (it.a.z + it.b.z) / 2);
    const s = viewer.worldToScreen(_midV);
    if (s.behind) { it.label.style.display = 'none'; continue; }
    it.label.style.display = '';
    it.label.style.left = s.x + 'px';
    it.label.style.top = s.y + 'px';
  }
  // Live-Vorschau während des Messens
  if (measuring && firstPoint && lastNDC) {
    const hit = viewer.raycastModel(lastNDC.x, lastNDC.y);
    if (hit) {
      const cur = hit.point;
      if (!previewLine) { previewLine = makeLine(firstPoint, cur, 0xffffff); previewLine.material = lineMat(0xffffff, true); }
      previewLine.geometry.setFromPoints([firstPoint, cur]);
      previewLine.geometry.attributes.position.needsUpdate = true;
      if (!previewLabel) {
        previewLabel = document.createElement('div');
        previewLabel.className = 'meas-label preview';
        labelsEl.appendChild(previewLabel);
      }
      previewLabel.textContent = fmt(firstPoint.distanceTo(cur));
      _midV.set((firstPoint.x + cur.x) / 2, (firstPoint.y + cur.y) / 2, (firstPoint.z + cur.z) / 2);
      const s = viewer.worldToScreen(_midV);
      previewLabel.style.display = s.behind ? 'none' : '';
      previewLabel.style.left = s.x + 'px';
      previewLabel.style.top = s.y + 'px';
    }
  }
}

function clearPreview() {
  disposeObj(previewLine); previewLine = null;
  if (previewLabel) { previewLabel.remove(); previewLabel = null; }
  if (firstSphere) { disposeObj(firstSphere); firstSphere = null; }
  firstPoint = null;
}

// ---------------------------------------------------------------------------
//  Mess-Modus
// ---------------------------------------------------------------------------
function setMeasuring(v) {
  measuring = v;
  document.body.classList.toggle('meas-measuring', v);
  btnMeasure.classList.toggle('active', v);
  if (!v) clearPreview();
  if (v) window.dispatchEvent(new CustomEvent('tool:active', { detail: 'measure' }));
}
btnMeasure.addEventListener('click', () => {
  if (!CONFIGURED) { alert('The measurement backend is not set up yet (run the SQL in Supabase).'); return; }
  setMeasuring(!measuring);
});
window.addEventListener('tool:active', (e) => { if (e.detail !== 'measure' && measuring) setMeasuring(false); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && measuring) { if (firstPoint) clearPreview(); else setMeasuring(false); } });

// Klickerkennung (Klick, kein Ziehen)
let down = null;
function onDown(e) { if (e.button === 0) down = { x: e.clientX, y: e.clientY, t: Date.now() }; }
function onUp(e) {
  if (e.button !== 0 || !down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const quick = Date.now() - down.t < 500;
  down = null;
  if (!measuring || !quick || moved > 6) return;
  if (viewer.isLooking && viewer.isLooking()) return;
  const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
  const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
  const hit = viewer.raycastModel(ndcX, ndcY);
  if (!hit) return;
  if (!firstPoint) {
    firstPoint = hit.point.clone();
    firstSphere = makeSphere(firstPoint);
  } else {
    const b = hit.point.clone();
    const a = firstPoint.clone();
    clearPreview();
    createMeasurement(a, b);
  }
}
function onMove(e) {
  if (!measuring) return;
  lastNDC = { x: (e.clientX / window.innerWidth) * 2 - 1, y: -(e.clientY / window.innerHeight) * 2 + 1 };
}

// ---------------------------------------------------------------------------
//  Start
// ---------------------------------------------------------------------------
function start() {
  viewer = window.viewer;
  THREE = viewer.THREE;
  curMode = viewer.getScanMode ? viewer.getScanMode() : null;
  window.addEventListener('scan-mode', (e) => { curMode = (e.detail && e.detail.mode) || (e.detail && e.detail.scan ? 'scan' : 'cad'); });
  viewer.addFrameCallback(frame);
  const dom = viewer.domElement;
  dom.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  dom.addEventListener('pointermove', onMove);
  initBackend();
}
if (window.viewer && window.viewer.getModel && window.viewer.getModel()) start();
else window.addEventListener('viewer-ready', start, { once: true });
