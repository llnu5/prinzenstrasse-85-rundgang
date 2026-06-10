// ===========================================================================
//  Kollaboratives Kommentar-/Annotationssystem (wie Google Slides)
//  - Besucher vergeben sich einen Namen
//  - Klick ins 3D-Modell setzt einen Pin
//  - Threads mit Antworten + "Erledigt"-Status
//  - Echtzeit-Sync über Supabase
// ===========================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import * as THREE from 'three';

const URL = window.SUPABASE_URL;
const KEY = window.SUPABASE_ANON_KEY;
const CONFIGURED = typeof URL === 'string' && URL.startsWith('http') && typeof KEY === 'string' && KEY.length > 20;

// Projekt-Scope: Annotationen gehören zu genau einem Projekt (NULL = Standard).
const PID = window.PROJECT_ID || null;
const scope = (q) => (PID ? q.eq('project_id', PID) : q.is('project_id', null));
const inProject = (row) => ((row && row.project_id) || null) === PID;

// ---------------------------------------------------------------------------
//  Styles
// ---------------------------------------------------------------------------
const css = document.createElement('style');
css.textContent = `
  #cmt-pins { position: fixed; inset: 0; z-index: 16; pointer-events: none; overflow: hidden; }
  .cmt-pin {
    position: absolute; transform: translate(-50%, -100%); pointer-events: auto; cursor: pointer;
    width: 30px; height: 38px; margin-top: -2px; will-change: transform, left, top;
    transition: opacity .15s; filter: drop-shadow(0 2px 4px rgba(0,0,0,.45));
  }
  .cmt-pin .bubble {
    width: 30px; height: 30px; border-radius: 50% 50% 50% 2px;
    background: #f5b301; border: 2px solid #fff; transform: rotate(45deg);
    display: flex; align-items: center; justify-content: center;
  }
  .cmt-pin .ini { transform: rotate(-45deg); color: #1a1a1a; font-weight: 700; font-size: 12px;
    font-family: var(--font); }
  .cmt-pin.resolved .bubble { background: #4caf6a; }
  .cmt-pin.active .bubble { box-shadow: 0 0 0 3px rgba(78,161,255,.9); }
  .cmt-pin .cnt { position: absolute; top: -6px; right: -6px; background: #2a323d; color:#fff;
    border:1px solid rgba(255,255,255,.25); border-radius: 9px; min-width: 16px; height: 16px;
    font-size: 10px; line-height: 14px; text-align: center; padding: 0 3px; font-weight: 600; }

  .cmt-card {
    position: fixed; z-index: 40; background: rgba(20,24,30,.97); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,255,255,.1); border-radius: 12px; color: #e8edf2;
    width: 300px; max-width: calc(100vw - 24px); box-shadow: 0 12px 40px rgba(0,0,0,.5);
    font-family: var(--font); font-size: 13px;
  }
  .cmt-card .hd { display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .cmt-card .hd .ttl { font-weight: 600; font-size: 13px; }
  .cmt-card .x { cursor:pointer; color:#8a94a0; font-size:18px; line-height:1; padding:0 2px; }
  .cmt-card .x:hover { color:#fff; }
  .cmt-msgs { max-height: 46vh; overflow-y: auto; padding: 6px 12px; }
  .cmt-msg { padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,.06); }
  .cmt-msg:last-child { border-bottom: 0; }
  .cmt-msg .top { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-bottom:2px; }
  .cmt-msg .who { font-weight:600; color:#fff; }
  .cmt-msg .when { color:#7b8590; font-size:11px; white-space:nowrap; }
  .cmt-msg .txt { color:#cdd5de; white-space:pre-wrap; word-break:break-word; line-height:1.45; }
  .cmt-msg .del { float:right; color:#7b8590; cursor:pointer; font-size:11px; margin-left:8px; }
  .cmt-msg .del:hover { color:#ff7676; }
  .cmt-foot { padding: 10px 12px; border-top: 1px solid rgba(255,255,255,.08); }
  .cmt-card textarea {
    width:100%; resize:vertical; min-height:38px; max-height:140px; background:#11151b;
    border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#e8edf2; padding:8px 10px;
    font:inherit; font-size:13px; outline:none;
  }
  .cmt-card textarea:focus { border-color:#4ea1ff; }
  .cmt-row { display:flex; gap:8px; align-items:center; margin-top:8px; }
  .cmt-btn { background:#2a323d; border:1px solid rgba(255,255,255,.1); color:#e8edf2;
    border-radius:8px; padding:7px 12px; font:inherit; font-size:12.5px; cursor:pointer; transition:background .15s; }
  .cmt-btn:hover { background:#39434f; }
  .cmt-btn.primary { background:#3b82f6; border-color:#3b82f6; color:#fff; }
  .cmt-btn.primary:hover { background:#2f6fe0; }
  .cmt-btn.good { background:#2e7d4f; border-color:#2e7d4f; color:#fff; }
  .cmt-btn.good:hover { background:#276e44; }
  .cmt-btn.ghost { background:transparent; }
  .cmt-spacer { flex:1; }

  /* Sidebar (Kommentarliste) */
  #cmt-sidebar {
    position: fixed; top:0; right:0; height:100%; width:320px; max-width:86vw; z-index:30;
    background: rgba(16,19,24,.96); backdrop-filter: blur(10px); border-left:1px solid rgba(255,255,255,.08);
    transform: translateX(100%); transition: transform .25s ease; display:flex; flex-direction:column;
    color:#e8edf2; font-family:var(--font);
  }
  #cmt-sidebar.open { transform: translateX(0); }
  #cmt-sidebar .sb-hd { padding:14px 14px 10px; border-bottom:1px solid rgba(255,255,255,.08); }
  #cmt-sidebar .sb-hd .row1 { display:flex; align-items:center; justify-content:space-between; }
  #cmt-sidebar h2 { font-size:15px; font-weight:600; }
  #cmt-filter { display:flex; gap:6px; margin-top:10px; }
  #cmt-filter button { flex:1; background:#1b2129; border:1px solid rgba(255,255,255,.08); color:#aab3bd;
    border-radius:7px; padding:6px 4px; font:inherit; font-size:12px; cursor:pointer; }
  #cmt-filter button.on { background:#2c3744; color:#fff; border-color:rgba(78,161,255,.5); }
  #cmt-list { flex:1; overflow-y:auto; padding:8px 10px; }
  .cmt-item { background:#161b22; border:1px solid rgba(255,255,255,.07); border-radius:10px;
    padding:10px 11px; margin-bottom:8px; cursor:pointer; transition:border-color .15s, background .15s; }
  .cmt-item:hover { border-color:rgba(78,161,255,.5); background:#1a2029; }
  .cmt-item.resolved { opacity:.6; }
  .cmt-item .it-top { display:flex; align-items:center; gap:6px; margin-bottom:3px; }
  .cmt-item .av { width:18px; height:18px; border-radius:50%; background:#f5b301; color:#1a1a1a;
    font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
  .cmt-item.resolved .av { background:#4caf6a; }
  .cmt-item .who { font-weight:600; font-size:12.5px; color:#fff; }
  .cmt-item .when { color:#7b8590; font-size:11px; margin-left:auto; }
  .cmt-item .snip { color:#b9c2cc; font-size:12.5px; line-height:1.4; max-height:3em; overflow:hidden; }
  .cmt-item .meta { display:flex; gap:8px; margin-top:5px; color:#7b8590; font-size:11px; }
  .cmt-item .badge { color:#4caf6a; }
  #cmt-empty { color:#7b8590; font-size:13px; text-align:center; padding:30px 16px; line-height:1.5; }

  /* Toolbar-Buttons (im vorhandenen #topbar) */
  #topbar .sep { width:1px; height:22px; background:rgba(255,255,255,.14); margin:0 2px; }

  /* Namensschild */
  #cmt-name { position: fixed; top:14px; right:14px; z-index:25;
    background: rgba(16,19,24,.82); backdrop-filter: blur(8px); border:1px solid rgba(255,255,255,.08);
    border-radius:10px; color:#cdd5de; font-size:12.5px; padding:7px 11px; cursor:pointer; user-select:none;
    display:flex; align-items:center; gap:7px; font-family:var(--font); }
  #cmt-name:hover { color:#fff; }
  #cmt-name .av { width:20px; height:20px; border-radius:50%; background:#3b82f6; color:#fff;
    font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; }

  body.cmt-placing #app, body.cmt-placing canvas { cursor: crosshair !important; }
  #cmt-hint { position:fixed; top:60px; left:50%; transform:translateX(-50%); z-index:25;
    background:rgba(59,130,246,.95); color:#fff; padding:8px 16px; border-radius:20px; font-size:13px;
    font-family:var(--font); box-shadow:0 4px 16px rgba(0,0,0,.4);
    display:none; pointer-events:none; }
  body.cmt-placing #cmt-hint { display:block; }

  /* Modal (Name) */
  #cmt-modal { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.55); backdrop-filter:blur(3px);
    display:none; align-items:center; justify-content:center; }
  #cmt-modal.open { display:flex; }
  #cmt-modal .box { background:#161b22; border:1px solid rgba(255,255,255,.12); border-radius:14px;
    padding:22px; width:340px; max-width:90vw; color:#e8edf2; font-family:var(--font);
    box-shadow:0 20px 60px rgba(0,0,0,.6); }
  #cmt-modal h3 { font-size:16px; margin-bottom:6px; }
  #cmt-modal p { font-size:12.5px; color:#8a94a0; margin-bottom:14px; }
  #cmt-modal input { width:100%; background:#11151b; border:1px solid rgba(255,255,255,.14);
    border-radius:8px; color:#fff; padding:10px 12px; font:inherit; font-size:14px; outline:none; }
  #cmt-modal input:focus { border-color:#3b82f6; }

  @media (max-width: 560px) {
    .cmt-card { width: calc(100vw - 24px); }
  }
  /* === Apple-HIG Redesign-Overrides === */
  .cmt-pin .bubble { border-radius: 50% 50% 50% 3px; border: 2px solid rgba(255,255,255,.92); }
  .cmt-pin.resolved .bubble { background: var(--green); }
  .cmt-pin.active .bubble { box-shadow: 0 0 0 3px rgba(10,132,255,.9); }
  .cmt-pin .cnt { background:#2c2c2e; border:1.5px solid rgba(255,255,255,.3); }
  .cmt-card { background: var(--mat-2); -webkit-backdrop-filter: var(--blur); backdrop-filter: var(--blur);
    border:1px solid var(--hairline); border-radius: var(--radius-lg); box-shadow: var(--shadow); overflow:hidden; font-family:var(--font); }
  .cmt-card .hd { padding:11px 14px; border-bottom:1px solid var(--hairline-soft); }
  .cmt-card .x { color:var(--label3); } .cmt-card .x:hover { color:var(--label); }
  .cmt-msgs { padding:4px 14px; } .cmt-msg { padding:10px 0; border-bottom:1px solid var(--hairline-soft); }
  .cmt-msg .who { color:var(--label); } .cmt-msg .when { color:var(--label3); } .cmt-msg .txt { color:var(--label2); line-height:1.5; }
  .cmt-msg .del:hover { color:var(--red); }
  .cmt-foot { padding:11px 14px; border-top:1px solid var(--hairline-soft); }
  .cmt-card textarea { background:rgba(0,0,0,.3); border:1px solid var(--hairline); border-radius:10px; color:var(--label); padding:9px 11px; }
  .cmt-card textarea:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(10,132,255,.2); }
  .cmt-btn { background:rgba(118,118,128,.24); border:0; color:var(--label); border-radius:9px; padding:8px 14px; font-weight:600; transition:background .15s, transform .08s; }
  .cmt-btn:hover { background:rgba(118,118,128,.4); } .cmt-btn:active { transform:scale(.96); }
  .cmt-btn.primary { background:var(--blue); color:#fff; } .cmt-btn.primary:hover { background:#0a76e6; }
  .cmt-btn.good { background:var(--green); color:#04210f; } .cmt-btn.good:hover { background:#2bbd50; }
  .cmt-btn.ghost { background:transparent; color:var(--label2); } .cmt-btn.ghost:hover { background:rgba(255,255,255,.08); color:var(--label); }
  #cmt-sidebar { background:var(--mat-2); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border-left:1px solid var(--hairline); width:330px; transition:transform .3s cubic-bezier(.32,.72,0,1); box-shadow:-12px 0 40px rgba(0,0,0,.4); }
  #cmt-sidebar .sb-hd { padding:16px 16px 12px; }
  #cmt-sidebar h2 { font-size:17px; font-weight:700; }
  #cmt-filter { gap:2px; padding:2px; background:rgba(118,118,128,.22); border-radius:10px; }
  #cmt-filter button { background:transparent; border:0; color:var(--label2); border-radius:8px; }
  #cmt-filter button.on { background:rgba(120,120,128,.5); color:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); }
  .cmt-item { background:rgba(255,255,255,.05); border:1px solid var(--hairline-soft); border-radius:12px; transition:background .15s, transform .08s; }
  .cmt-item:hover { background:rgba(255,255,255,.09); border-color:var(--hairline-soft); }
  .cmt-item:active { transform:scale(.985); }
  .cmt-item .who { color:var(--label); } .cmt-item .when { color:var(--label3); } .cmt-item .snip { color:var(--label2); }
  .cmt-item .meta { color:var(--label3); } .cmt-item .badge { color:var(--green); }
  .cmt-item.resolved .av { background:var(--green); }
  #cmt-empty { color:var(--label3); }
  #cmt-name { background:var(--mat); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border:1px solid var(--hairline); border-radius:var(--pill); color:var(--label2); padding:6px 12px 6px 7px; gap:8px; box-shadow:var(--shadow); }
  #cmt-name:hover { color:var(--label); }
  #cmt-name .av { width:22px; height:22px; background:var(--blue); }
  #cmt-hint { top:68px; background:rgba(10,132,255,.92); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    padding:9px 18px; border-radius:var(--pill); font-weight:500; box-shadow:var(--shadow); }
  #cmt-modal { background:rgba(0,0,0,.5); -webkit-backdrop-filter:blur(6px); backdrop-filter:blur(6px); }
  #cmt-modal .box { background:var(--mat-2); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border:1px solid var(--hairline); border-radius:20px; box-shadow:0 24px 70px rgba(0,0,0,.6); }
  #cmt-modal h3 { font-size:18px; font-weight:700; } #cmt-modal p { color:var(--label2); }
  #cmt-modal input { background:rgba(0,0,0,.3); border:1px solid var(--hairline); border-radius:10px; }
  #cmt-modal input:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(10,132,255,.25); }
`;
document.head.appendChild(css);

// ---------------------------------------------------------------------------
//  DOM aufbauen
// ---------------------------------------------------------------------------
const topbar = document.getElementById('topbar');
const btnAdd = el('button', 'btn');
btnAdd.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-5.7-6.5-10.5A6.5 6.5 0 0 1 18.5 10.5C18.5 15.3 12 21 12 21z"/><circle cx="12" cy="10.2" r="2.4"/></svg><span>Comment</span>`;
btnAdd.dataset.tip = 'Comment'; btnAdd.setAttribute('aria-label', 'Add comment');
const btnList = el('button', 'btn');
btnList.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg><span>List</span>`;
btnList.dataset.tip = 'List'; btnList.setAttribute('aria-label', 'Comment list');
const sep = el('div', 'sep');
topbar.append(sep, btnAdd, btnList);

const pins = el('div'); pins.id = 'cmt-pins'; document.body.appendChild(pins);

const nameBadge = el('div'); nameBadge.id = 'cmt-name';
document.body.appendChild(nameBadge);

const hint = el('div'); hint.id = 'cmt-hint'; hint.textContent = 'Click a spot on the model to add a comment · Esc cancels';
document.body.appendChild(hint);

const sidebar = el('div'); sidebar.id = 'cmt-sidebar';
sidebar.innerHTML = `
  <div class="sb-hd">
    <div class="row1"><h2>Comments</h2><span class="x" id="cmt-sb-x" style="cursor:pointer;color:#8a94a0;font-size:20px">×</span></div>
    <div id="cmt-filter">
      <button data-f="open" class="on">Open</button>
      <button data-f="resolved">Done</button>
      <button data-f="all">All</button>
    </div>
  </div>
  <div id="cmt-list"></div>`;
document.body.appendChild(sidebar);

const modal = el('div'); modal.id = 'cmt-modal';
modal.innerHTML = `<div class="box">
  <h3>What's your name?</h3>
  <p>Your name appears on your comments.</p>
  <input id="cmt-name-input" type="text" maxlength="40" placeholder="e.g. Linus" autocomplete="off" />
  <div class="cmt-row" style="margin-top:14px"><div class="cmt-spacer"></div>
    <button class="cmt-btn primary" id="cmt-name-ok">Continue</button></div>
</div>`;
document.body.appendChild(modal);

// ---------------------------------------------------------------------------
//  Zustand
// ---------------------------------------------------------------------------
let viewer = null;
let sb = null;
const threads = new Map();          // id -> {id, author, body, pos:Vector3, resolved, created_at, comments:[]}
const pinEls = new Map();           // id -> HTMLElement
let placing = false;
let filter = 'open';
let activeId = null;                // offener Thread-Dialog
let pending = null;                 // {pos:Vector3} beim Setzen, vor erstem Kommentar
let name = localStorage.getItem('cmt_name') || '';
let occFrame = 0;

renderNameBadge();

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function initial(n) { return (n || '?').trim().charAt(0).toUpperCase() || '?'; }
// Name -> feste, gut unterscheidbare Farbe (gleicher Name = gleiche Farbe für alle)
function colorFor(n) {
  const s = (n || 'Guest').trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 68%, 60%)`;
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function timeAgo(iso) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d} d ago`;
  return new Date(iso).toLocaleDateString('en-US');
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Name sicherstellen (öffnet Modal, ruft danach cb auf)
let nameResolver = null;
function requireName() {
  return new Promise((res) => {
    if (name) return res(name);
    nameResolver = res;
    modal.classList.add('open');
    const inp = document.getElementById('cmt-name-input');
    inp.value = ''; setTimeout(() => inp.focus(), 50);
  });
}
function submitName() {
  const v = document.getElementById('cmt-name-input').value.trim();
  if (!v) return;
  name = v; localStorage.setItem('cmt_name', name);
  renderNameBadge();
  modal.classList.remove('open');
  if (nameResolver) { nameResolver(name); nameResolver = null; }
}
document.getElementById('cmt-name-ok').addEventListener('click', submitName);
document.getElementById('cmt-name-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitName(); }
});

function renderNameBadge() {
  if (name) nameBadge.innerHTML = `<span class="av" style="background:${colorFor(name)}">${esc(initial(name))}</span><span>${esc(name)}</span>`;
  else nameBadge.innerHTML = `<span class="av">?</span><span>Set name</span>`;
}
nameBadge.addEventListener('click', async () => {
  name = ''; renderNameBadge(); await requireName();
});

// ---------------------------------------------------------------------------
//  Supabase
// ---------------------------------------------------------------------------
async function initBackend() {
  if (!CONFIGURED) {
    btnAdd.title = 'Backend not configured (config.js)';
    console.warn('[comments] Supabase not configured – comments disabled. Add URL/Key in config.js.');
    return;
  }
  sb = createClient(URL, KEY, { realtime: { params: { eventsPerSecond: 5 } } });
  await loadAll();
  sb.channel('rundgang')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'threads' }, (p) => onThreadChange(p))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'comments' }, (p) => onCommentChange(p))
    .subscribe();
}

async function loadAll() {
  const { data: th, error: e1 } = await scope(sb.from('threads').select('*')).order('created_at');
  const { data: cm, error: e2 } = await scope(sb.from('comments').select('*')).order('created_at');
  if (e1 || e2) { console.error('[comments] load', e1 || e2); return; }
  threads.clear();
  for (const t of th) threads.set(t.id, toThread(t));
  for (const c of cm) { const t = threads.get(c.thread_id); if (t) t.comments.push(c); }
  syncPins(); renderList();
}

function toThread(t) {
  return { id: t.id, author: t.author, body: t.body, resolved: t.resolved, view: t.view || null,
    created_at: t.created_at, pos: new THREE.Vector3(t.pos_x, t.pos_y, t.pos_z), comments: [] };
}
let curMode = null;   // aktueller Scan-View-Modus: null=kein Switch | 'cad' | 'scan'
const visibleForThread = (t) => !curMode || !t.view || t.view === curMode;

function onThreadChange(p) {
  if (!inProject(p.new) && !inProject(p.old)) return;
  if (p.eventType === 'DELETE') { threads.delete(p.old.id); if (activeId === p.old.id) closeCard(); }
  else {
    const ex = threads.get(p.new.id);
    const nt = toThread(p.new);
    if (ex) nt.comments = ex.comments;
    threads.set(nt.id, nt);
  }
  syncPins(); renderList();
  if (activeId === (p.new && p.new.id)) openThread(activeId, true);
}
function onCommentChange(p) {
  if (!inProject(p.new) && !inProject(p.old)) return;
  if (p.eventType === 'INSERT') {
    const t = threads.get(p.new.thread_id);
    if (t && !t.comments.some((c) => c.id === p.new.id)) t.comments.push(p.new);
  } else if (p.eventType === 'DELETE') {
    const t = threads.get(p.old.thread_id);
    if (t) t.comments = t.comments.filter((c) => c.id !== p.old.id);
  }
  renderList();
  if (activeId) openThread(activeId, true);
}

// ---------------------------------------------------------------------------
//  Aktionen
// ---------------------------------------------------------------------------
async function createThread(pos, body) {
  const { data, error } = await sb.from('threads')
    .insert({ author: name, body, pos_x: pos.x, pos_y: pos.y, pos_z: pos.z, project_id: PID, view: curMode })
    .select().single();
  if (error) { alert('Could not save comment: ' + error.message); return; }
  threads.set(data.id, toThread(data));
  syncPins(); renderList();
  // Input field stays closed – the new pin is placed; clicking it opens the thread.
}
async function addReply(threadId, body) {
  const { data, error } = await sb.from('comments')
    .insert({ thread_id: threadId, author: name, body, project_id: PID }).select().single();
  if (error) { alert('Reply failed: ' + error.message); return; }
  const t = threads.get(threadId);
  if (t && !t.comments.some((c) => c.id === data.id)) t.comments.push(data);
  renderList(); openThread(threadId, true);
}
async function setResolved(threadId, val) {
  const t = threads.get(threadId); if (t) t.resolved = val;
  syncPins(); renderList(); openThread(threadId, true);
  const { error } = await sb.from('threads').update({ resolved: val }).eq('id', threadId);
  if (error) { alert('Status update failed: ' + error.message); }
}
async function deleteThread(threadId) {
  if (!confirm('Delete this comment and its replies?')) return;
  threads.delete(threadId); syncPins(); renderList(); closeCard();
  await sb.from('threads').delete().eq('id', threadId);
}
async function deleteComment(threadId, commentId) {
  const t = threads.get(threadId); if (t) t.comments = t.comments.filter((c) => c.id !== commentId);
  renderList(); openThread(threadId, true);
  await sb.from('comments').delete().eq('id', commentId);
}

// ---------------------------------------------------------------------------
//  Pins (3D -> Bildschirm)
// ---------------------------------------------------------------------------
function visibleThreads() {
  const arr = [...threads.values()].filter(visibleForThread);
  return arr.filter((t) => filter === 'all' ? true : filter === 'resolved' ? t.resolved : !t.resolved);
}

function syncPins() {
  const shouldShow = new Set(
    [...threads.values()].filter((t) => (t.resolved ? (filter !== 'open') : true) && visibleForThread(t)).map((t) => t.id)
  );
  // entfernen
  for (const [id, e] of pinEls) if (!threads.has(id) || !shouldShow.has(id)) { e.remove(); pinEls.delete(id); }
  // hinzufügen
  for (const t of threads.values()) {
    if (!shouldShow.has(t.id)) continue;
    let e = pinEls.get(t.id);
    if (!e) {
      e = el('div', 'cmt-pin');
      e.innerHTML = `<div class="bubble"><span class="ini"></span></div><div class="cnt"></div>`;
      e.addEventListener('click', (ev) => { ev.stopPropagation(); focusThread(t.id); });
      pins.appendChild(e); pinEls.set(t.id, e);
    }
    e.classList.toggle('resolved', t.resolved);
    e.classList.toggle('active', activeId === t.id);
    e.querySelector('.ini').textContent = initial(t.author);
    // Pin-Farbe pro Nutzer (erledigte bleiben grün über CSS)
    e.querySelector('.bubble').style.background = t.resolved ? '' : colorFor(t.author);
    const cnt = 1 + t.comments.length;
    const cE = e.querySelector('.cnt');
    cE.textContent = cnt; cE.style.display = cnt > 1 ? '' : 'none';
  }
}

// jeden Frame: Pins positionieren
function updatePins() {
  if (!viewer || pinEls.size === 0) return;
  occFrame++;
  const doOcc = occFrame % 6 === 0;
  for (const [id, e] of pinEls) {
    const t = threads.get(id); if (!t) continue;
    const s = viewer.worldToScreen(t.pos);
    if (s.behind) { e.style.display = 'none'; continue; }
    e.style.display = '';
    e.style.left = s.x + 'px';
    e.style.top = s.y + 'px';
    if (doOcc) e.style.opacity = viewer.isOccluded(t.pos) ? '0.32' : '1';
  }
}

// ---------------------------------------------------------------------------
//  Karten: neuer Kommentar / Thread
// ---------------------------------------------------------------------------
let card = null;
function closeCard() {
  if (card) { card.remove(); card = null; }
  if (activeId) { activeId = null; syncPins(); renderList(); }
}
function placeCard(node, screen) {
  const w = 300, pad = 12;
  let left = clamp(screen.x + 20, pad, window.innerWidth - w - pad);
  let top = clamp(screen.y - 40, pad, window.innerHeight - 220);
  node.style.left = left + 'px'; node.style.top = top + 'px';
}

// Compose-Karte beim Setzen eines neuen Pins
function openCompose(pos, screen) {
  closeCard();
  pending = { pos };
  card = el('div', 'cmt-card');
  card.innerHTML = `
    <div class="hd"><span class="ttl">New comment</span><span class="x">×</span></div>
    <div class="cmt-foot" style="border-top:0">
      <textarea placeholder="Write a comment…"></textarea>
      <div class="cmt-row"><div class="cmt-spacer"></div>
        <button class="cmt-btn ghost" data-act="cancel">Cancel</button>
        <button class="cmt-btn primary" data-act="send">Comment</button>
      </div>
    </div>`;
  document.body.appendChild(card);
  placeCard(card, screen);
  const ta = card.querySelector('textarea'); setTimeout(() => ta.focus(), 40);
  card.querySelector('.x').onclick = () => { pending = null; closeCard(); };
  card.querySelector('[data-act="cancel"]').onclick = () => { pending = null; closeCard(); };
  const send = async () => {
    const body = ta.value.trim(); if (!body) return;
    await requireName();
    const p = pending.pos; pending = null;
    const node = card; card = null; node.remove();
    await createThread(p, body);
  };
  card.querySelector('[data-act="send"]').onclick = send;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
}

// Thread-Dialog (bestehender Pin)
function openThread(id, keepPos) {
  const t = threads.get(id); if (!t) return;
  const prevScroll = card ? card.querySelector('.cmt-msgs')?.scrollTop : null;
  const screen = viewer ? viewer.worldToScreen(t.pos) : { x: window.innerWidth / 2, y: 160 };
  activeId = id;
  if (!card || !keepPos) { if (card) card.remove(); card = el('div', 'cmt-card'); document.body.appendChild(card); }
  const msgs = [{ id: '_root', author: t.author, body: t.body, created_at: t.created_at, root: true }, ...t.comments];
  card.innerHTML = `
    <div class="hd">
      <span class="ttl">${t.resolved ? '✓ Done' : 'Comment'}</span>
      <span style="display:flex;gap:6px;align-items:center">
        <button class="cmt-btn ${t.resolved ? '' : 'good'}" data-act="resolve" style="padding:4px 9px;font-size:11.5px">${t.resolved ? 'Reopen' : '✓ Done'}</button>
        <span class="x">×</span>
      </span>
    </div>
    <div class="cmt-msgs">
      ${msgs.map((m) => `
        <div class="cmt-msg">
          <div class="top"><span class="who">${esc(m.author)}</span>
            <span class="when">${timeAgo(m.created_at)}
              ${(m.author === name) ? `<span class="del" data-del="${m.id}" data-root="${m.root ? 1 : 0}">delete</span>` : ''}
            </span></div>
          <div class="txt">${esc(m.body)}</div>
        </div>`).join('')}
    </div>
    <div class="cmt-foot">
      <textarea placeholder="Reply…"></textarea>
      <div class="cmt-row"><div class="cmt-spacer"></div>
        <button class="cmt-btn primary" data-act="reply">Reply</button></div>
    </div>`;
  if (!keepPos) placeCard(card, screen);
  const mc = card.querySelector('.cmt-msgs');
  if (prevScroll != null) mc.scrollTop = prevScroll; else mc.scrollTop = mc.scrollHeight;

  card.querySelector('.x').onclick = closeCard;
  card.querySelector('[data-act="resolve"]').onclick = () => setResolved(id, !t.resolved);
  const ta = card.querySelector('textarea');
  const reply = async () => {
    const body = ta.value.trim(); if (!body) return;
    await requireName(); ta.value = '';
    await addReply(id, body);
  };
  card.querySelector('[data-act="reply"]').onclick = reply;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); reply(); } });
  card.querySelectorAll('[data-del]').forEach((d) => d.addEventListener('click', () => {
    if (d.dataset.root === '1') deleteThread(id); else deleteComment(id, d.dataset.del);
  }));
  syncPins();
}

// Pin/Liste anklicken -> hinfliegen + öffnen
function focusThread(id) {
  const t = threads.get(id); if (!t) return;
  if (viewer) viewer.flyTo(t.pos);
  openThread(id);
}

// ---------------------------------------------------------------------------
//  Liste / Sidebar
// ---------------------------------------------------------------------------
function renderList() {
  const list = document.getElementById('cmt-list');
  const arr = visibleThreads().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const counts = { open: 0, resolved: 0 };
  for (const t of threads.values()) { if (!visibleForThread(t)) continue; t.resolved ? counts.resolved++ : counts.open++; }
  document.querySelector('#cmt-filter [data-f="open"]').textContent = `Open (${counts.open})`;
  document.querySelector('#cmt-filter [data-f="resolved"]').textContent = `Done (${counts.resolved})`;

  if (arr.length === 0) {
    list.innerHTML = `<div id="cmt-empty">${filter === 'open'
      ? 'No open comments yet.<br>Click “💬 Comment” and then on the model.'
      : 'No entries in this view.'}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const t of arr) {
    const it = el('div', 'cmt-item' + (t.resolved ? ' resolved' : ''));
    it.innerHTML = `
      <div class="it-top">
        <span class="av" style="${t.resolved ? '' : 'background:' + colorFor(t.author)}">${esc(initial(t.author))}</span>
        <span class="who">${esc(t.author)}</span>
        <span class="when">${timeAgo(t.created_at)}</span>
      </div>
      <div class="snip">${esc(t.body)}</div>
      <div class="meta">
        ${t.comments.length ? `<span>💬 ${t.comments.length} ${t.comments.length > 1 ? 'replies' : 'reply'}</span>` : ''}
        ${t.resolved ? '<span class="badge">✓ done</span>' : ''}
      </div>`;
    it.addEventListener('click', () => { focusThread(t.id); });
    list.appendChild(it);
  }
}

document.querySelectorAll('#cmt-filter button').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.f;
  document.querySelectorAll('#cmt-filter button').forEach((x) => x.classList.toggle('on', x === b));
  syncPins(); renderList();
}));
document.getElementById('cmt-sb-x').addEventListener('click', () => sidebar.classList.remove('open'));
btnList.addEventListener('click', () => { sidebar.classList.toggle('open'); btnList.classList.toggle('active', sidebar.classList.contains('open')); });

// ---------------------------------------------------------------------------
//  Platzierungsmodus
// ---------------------------------------------------------------------------
function setPlacing(v) {
  placing = v;
  document.body.classList.toggle('cmt-placing', v);
  btnAdd.classList.toggle('active', v);
  if (v) window.dispatchEvent(new CustomEvent('tool:active', { detail: 'comment' }));
}
// anderes Werkzeug aktiv -> Kommentar-Platzierung beenden
window.addEventListener('tool:active', (e) => { if (e.detail !== 'comment' && placing) setPlacing(false); });
btnAdd.addEventListener('click', async () => {
  if (!CONFIGURED) { alert('The comment backend is not set up yet (config.js).'); return; }
  if (!placing) await requireName();
  setPlacing(!placing);
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (placing) setPlacing(false); else if (card) closeCard(); } });

// Klick ins Modell (Klick, kein Ziehen)
let down = null;
function onDown(e) {
  if (e.button !== 0) return;
  down = { x: e.clientX, y: e.clientY, t: Date.now() };
}
function onUp(e) {
  if (e.button !== 0 || !down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const quick = Date.now() - down.t < 500;
  const wasDown = down; down = null;
  if (!placing || !quick || moved > 6) return;
  if (viewer && viewer.isLooking && viewer.isLooking()) return;
  const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
  const ndcY = -(e.clientY / window.innerHeight) * 2 + 1;
  const hit = viewer.raycastModel(ndcX, ndcY);
  if (!hit) return;
  setPlacing(false);
  openCompose(hit.point.clone(), { x: e.clientX, y: e.clientY });
}

// ---------------------------------------------------------------------------
//  Start
// ---------------------------------------------------------------------------
function start() {
  viewer = window.viewer;
  viewer.setFrameCallback(updatePins);
  const dom = viewer.domElement;
  dom.addEventListener('pointerdown', onDown);
  window.addEventListener('pointerup', onUp);
  curMode = viewer.getScanMode ? viewer.getScanMode() : null;
  window.addEventListener('scan-mode', (e) => {
    curMode = (e.detail && e.detail.mode) || (e.detail && e.detail.scan ? 'scan' : 'cad');
    syncPins(); renderList();
  });
  initBackend();
}
if (window.viewer && window.viewer.getModel && window.viewer.getModel()) start();
else window.addEventListener('viewer-ready', start, { once: true });
