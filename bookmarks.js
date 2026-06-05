// ===========================================================================
//  Bookmarks – benannte Ansichten als Navigationshilfe.
//  "+ Neue Bookmark" speichert die aktuelle Kamera-Pose; Klick fliegt animiert
//  dorthin. Geteilt & dauerhaft (Supabase), in Echtzeit für alle.
// ===========================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = window.SUPABASE_URL;
const KEY = window.SUPABASE_ANON_KEY;
const CONFIGURED = typeof URL === 'string' && URL.startsWith('http') && typeof KEY === 'string' && KEY.length > 20;

// ---------------------------------------------------------------------------
//  Styles
// ---------------------------------------------------------------------------
const css = document.createElement('style');
css.textContent = `
  #bm-panel {
    position: fixed; left: 0; top: 92px; width: 240px; max-width: 80vw; max-height: calc(100vh - 200px); z-index: 28;
    background: rgba(16,19,24,.96); backdrop-filter: blur(10px); border:1px solid rgba(255,255,255,.08);
    border-left:0; border-radius:0 12px 12px 0; display:none; flex-direction:column; overflow:hidden;
    color:#e8edf2; font-family:var(--font); box-shadow:0 12px 40px rgba(0,0,0,.45);
  }
  #bm-panel.open { display:flex; }
  #bm-hd { display:flex; align-items:center; justify-content:space-between; padding:11px 13px; border-bottom:1px solid rgba(255,255,255,.08); }
  #bm-hd h2 { font-size:14.5px; font-weight:600; }
  #bm-hd .min { cursor:pointer; color:#8a94a0; font-size:20px; line-height:1; padding:0 4px; }
  #bm-hd .min:hover { color:#fff; }
  #bm-new { margin:10px 12px 6px; background:#2e7d4f; border:0; color:#fff; border-radius:8px; padding:9px; font:600 13px inherit; cursor:pointer; }
  #bm-new:hover { background:#276e44; }
  #bm-form { margin:0 12px 8px; display:none; gap:6px; flex-direction:column; }
  #bm-form.show { display:flex; }
  #bm-form input { background:#11151b; border:1px solid rgba(255,255,255,.14); border-radius:8px; color:#fff; padding:8px 10px; font:inherit; font-size:13px; outline:none; }
  #bm-form input:focus { border-color:#4ea1ff; }
  #bm-form .row { display:flex; gap:6px; }
  #bm-form button { flex:1; border:0; border-radius:8px; padding:7px; font:600 12.5px inherit; cursor:pointer; }
  #bm-save { background:#3b82f6; color:#fff; } #bm-save:hover{ background:#2f6fe0; }
  #bm-cancel { background:#2a323d; color:#cdd5de; } #bm-cancel:hover{ background:#39434f; }
  #bm-list { overflow-y:auto; padding:4px 10px 12px; display:flex; flex-direction:column; gap:6px; }
  .bm-item { display:flex; align-items:center; gap:6px; background:#161b22; border:1px solid rgba(255,255,255,.07);
    border-radius:9px; padding:0 4px 0 0; }
  .bm-item .go { flex:1; text-align:left; background:transparent; border:0; color:#e8edf2; padding:9px 11px; cursor:pointer; font:13px inherit; border-radius:9px; }
  .bm-item .go:hover { color:#fff; background:rgba(78,161,255,.12); }
  .bm-item .del { cursor:pointer; color:#6b7480; font-size:15px; padding:4px 7px; }
  .bm-item .del:hover { color:#ff7676; }
  #bm-empty { color:#7b8590; font-size:12.5px; text-align:center; padding:14px 8px; line-height:1.5; }
  /* === Apple-HIG Redesign-Overrides === */
  #bm-panel { background:var(--mat-2); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border:1px solid var(--hairline); border-left:0; border-radius:0 18px 18px 0; box-shadow:var(--shadow); font-family:var(--font); }
  #bm-hd { padding:13px 15px; border-bottom:1px solid var(--hairline-soft); }
  #bm-hd h2 { font-size:15px; font-weight:700; }
  #bm-hd .min { color:var(--label3); } #bm-hd .min:hover { color:var(--label); }
  #bm-new { margin:11px 12px 7px; background:var(--blue); border-radius:10px; font-weight:600; transition:background .15s, transform .08s; }
  #bm-new:hover { background:#0a76e6; } #bm-new:active { transform:scale(.98); }
  #bm-form input { background:rgba(0,0,0,.3); border:1px solid var(--hairline); border-radius:10px; }
  #bm-form input:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(10,132,255,.2); }
  #bm-form button { border-radius:9px; font-weight:600; }
  #bm-save { background:var(--blue); } #bm-save:hover { background:#0a76e6; }
  #bm-cancel { background:rgba(118,118,128,.24); color:var(--label2); } #bm-cancel:hover { background:rgba(118,118,128,.4); }
  .bm-item { background:rgba(255,255,255,.05); border:1px solid var(--hairline-soft); border-radius:11px; transition:background .15s; }
  .bm-item:hover { background:rgba(255,255,255,.09); }
  .bm-item .go { color:var(--label); border-radius:11px; } .bm-item .go:hover { background:rgba(10,132,255,.16); color:#fff; }
  .bm-item .del:hover { color:var(--red); }
  #bm-empty { color:var(--label3); }
`;
document.head.appendChild(css);

// ---------------------------------------------------------------------------
//  DOM
// ---------------------------------------------------------------------------
const topbar = document.getElementById('topbar');
const btnBm = document.createElement('button');
btnBm.className = 'btn';
btnBm.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.5a1 1 0 0 1 1-1z"/></svg><span>Bookmarks</span>`;
btnBm.title = 'Gespeicherte Ansichten';
topbar.appendChild(btnBm);

const panel = document.createElement('div');
panel.id = 'bm-panel';
panel.innerHTML = `
  <div id="bm-hd"><h2>🔖 Bookmarks</h2><span class="min" title="Minimieren">–</span></div>
  <button id="bm-new">+ Neue Bookmark</button>
  <div id="bm-form">
    <input id="bm-name" type="text" maxlength="60" placeholder="Name, z. B. Eingangstür" autocomplete="off" />
    <div class="row"><button id="bm-cancel">Abbrechen</button><button id="bm-save">Speichern</button></div>
  </div>
  <div id="bm-list"></div>`;
document.body.appendChild(panel);

const listEl = panel.querySelector('#bm-list');
const formEl = panel.querySelector('#bm-form');
const nameInput = panel.querySelector('#bm-name');

// ---------------------------------------------------------------------------
//  Zustand
// ---------------------------------------------------------------------------
let viewer = null, THREE = null, sb = null;
const bms = new Map();           // id -> row
let pendingPose = null;          // erfasste Pose beim Anlegen
let open = false;

function setOpen(v) { open = v; panel.classList.toggle('open', v); btnBm.classList.toggle('active', v); }
btnBm.addEventListener('click', () => setOpen(!open));
panel.querySelector('.min').addEventListener('click', () => setOpen(false));

// ---------------------------------------------------------------------------
//  Anlegen
// ---------------------------------------------------------------------------
panel.querySelector('#bm-new').addEventListener('click', () => {
  if (!viewer) return;
  pendingPose = viewer.getPose();        // aktuelle View JETZT einfrieren
  formEl.classList.add('show');
  nameInput.value = '';
  setTimeout(() => nameInput.focus(), 40);
});
panel.querySelector('#bm-cancel').addEventListener('click', () => { formEl.classList.remove('show'); pendingPose = null; });
panel.querySelector('#bm-save').addEventListener('click', saveBookmark);
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBookmark(); } });

async function saveBookmark() {
  const name = nameInput.value.trim();
  if (!name || !pendingPose) return;
  const p = pendingPose.pos, q = pendingPose.quat;
  formEl.classList.remove('show'); pendingPose = null;
  if (!sb) { alert('Backend nicht eingerichtet (SQL ausführen).'); return; }
  const row = { name, px: p.x, py: p.y, pz: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  const { data, error } = await sb.from('bookmarks').insert(row).select().single();
  if (error) { alert('Bookmark fehlgeschlagen: ' + error.message); return; }
  bms.set(data.id, data); render();
}
async function del(id) {
  bms.delete(id); render();
  if (sb) await sb.from('bookmarks').delete().eq('id', id);
}
function goto(b) {
  if (!viewer) return;
  const pos = new THREE.Vector3(b.px, b.py, b.pz);
  const quat = new THREE.Quaternion(b.qx, b.qy, b.qz, b.qw);
  viewer.flyToPose(pos, quat, 1.4);     // animierter Flug durch den Raum
}

// ---------------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------------
function render() {
  const arr = [...bms.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (arr.length === 0) { listEl.innerHTML = `<div id="bm-empty">Noch keine Bookmarks.<br>Stelle die gewünschte Ansicht ein und klicke „+ Neue Bookmark".</div>`; return; }
  listEl.innerHTML = '';
  for (const b of arr) {
    const it = document.createElement('div');
    it.className = 'bm-item';
    const go = document.createElement('button');
    go.className = 'go'; go.textContent = '📍 ' + b.name;
    go.addEventListener('click', () => goto(b));
    const del2 = document.createElement('span');
    del2.className = 'del'; del2.title = 'Bookmark löschen'; del2.textContent = '×';
    del2.addEventListener('click', () => del(b.id));
    it.append(go, del2);
    listEl.appendChild(it);
  }
}

// ---------------------------------------------------------------------------
//  Supabase
// ---------------------------------------------------------------------------
async function init() {
  if (!CONFIGURED) { btnBm.title = 'Backend nicht konfiguriert'; return; }
  sb = createClient(URL, KEY, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 5 } } });
  const { data, error } = await sb.from('bookmarks').select('*').order('created_at');
  if (error) { console.error('[bookmarks] load', error); return; }
  for (const b of data) bms.set(b.id, b);
  render();
  sb.channel('bm')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bookmarks' }, (p) => {
      if (p.eventType === 'INSERT') bms.set(p.new.id, p.new);
      else if (p.eventType === 'DELETE') bms.delete(p.old.id);
      else if (p.eventType === 'UPDATE') bms.set(p.new.id, p.new);
      render();
    })
    .subscribe();
}

// ---------------------------------------------------------------------------
//  Start
// ---------------------------------------------------------------------------
function start() { viewer = window.viewer; THREE = viewer.THREE; init(); }
if (window.viewer && window.viewer.getModel && window.viewer.getModel()) start();
else window.addEventListener('viewer-ready', start, { once: true });
