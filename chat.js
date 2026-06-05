// ===========================================================================
//  Chat – rechte Seitenleiste, minimierbar, Echtzeit für alle Besucher.
//  Jede Nachricht ist von jedem löschbar (offenes Feedback-Tool).
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
  #chat-panel {
    position: fixed; right: 0; top: 92px; bottom: 14px; width: 300px; max-width: 88vw; z-index: 28;
    background: rgba(16,19,24,.96); backdrop-filter: blur(10px); border:1px solid rgba(255,255,255,.08);
    border-right:0; border-radius: 12px 0 0 12px; display: none; flex-direction: column; overflow: hidden;
    color:#e8edf2; font-family:var(--font); box-shadow:0 12px 40px rgba(0,0,0,.45);
  }
  #chat-panel.open { display: flex; }
  #chat-hd { display:flex; align-items:center; justify-content:space-between; gap:8px;
    padding:11px 13px; border-bottom:1px solid rgba(255,255,255,.08); }
  #chat-hd h2 { font-size:14.5px; font-weight:600; display:flex; align-items:center; gap:7px; }
  #chat-hd .min { cursor:pointer; color:#8a94a0; font-size:20px; line-height:1; padding:0 4px; }
  #chat-hd .min:hover { color:#fff; }
  #chat-msgs { flex:1; overflow-y:auto; padding:10px 12px; display:flex; flex-direction:column; gap:9px; }
  .chat-m { font-size:13px; line-height:1.4; }
  .chat-m .top { display:flex; align-items:baseline; gap:6px; }
  .chat-m .who { font-weight:700; }
  .chat-m .when { color:#7b8590; font-size:10.5px; }
  .chat-m .del { margin-left:auto; color:#6b7480; cursor:pointer; font-size:11px; opacity:0; transition:opacity .12s; }
  .chat-m:hover .del { opacity:1; }
  .chat-m .del:hover { color:#ff7676; }
  .chat-m .body { color:#d4dbe2; white-space:pre-wrap; word-break:break-word; }
  #chat-empty { color:#7b8590; font-size:12.5px; text-align:center; margin:auto 0; padding:20px; }
  #chat-foot { padding:10px 12px; border-top:1px solid rgba(255,255,255,.08); display:flex; gap:8px; align-items:flex-end; }
  #chat-foot textarea { flex:1; resize:none; height:38px; max-height:110px; background:#11151b;
    border:1px solid rgba(255,255,255,.12); border-radius:8px; color:#e8edf2; padding:9px 10px; font:inherit; font-size:13px; outline:none; }
  #chat-foot textarea:focus { border-color:#4ea1ff; }
  #chat-send { background:#3b82f6; border:0; color:#fff; border-radius:8px; padding:0 13px; height:38px; cursor:pointer; font:600 13px inherit; }
  #chat-send:hover { background:#2f6fe0; }
  @media (max-width:560px){ #chat-panel{ top:84px; } }
  /* === Apple-HIG Redesign-Overrides === */
  #chat-panel { background:var(--mat-2); -webkit-backdrop-filter:var(--blur); backdrop-filter:var(--blur);
    border:1px solid var(--hairline); border-right:0; border-radius:18px 0 0 18px; box-shadow:var(--shadow); font-family:var(--font); }
  #chat-hd { padding:13px 15px; border-bottom:1px solid var(--hairline-soft); }
  #chat-hd h2 { font-size:15px; font-weight:700; }
  #chat-hd .min { color:var(--label3); } #chat-hd .min:hover { color:var(--label); }
  .chat-m .when { color:var(--label3); } .chat-m .body { color:var(--label2); }
  .chat-m .del { color:var(--label3); } .chat-m .del:hover { color:var(--red); }
  #chat-empty { color:var(--label3); }
  #chat-foot { padding:11px 12px; border-top:1px solid var(--hairline-soft); }
  #chat-foot textarea { background:rgba(0,0,0,.3); border:1px solid var(--hairline); border-radius:10px; color:var(--label); }
  #chat-foot textarea:focus { border-color:var(--blue); box-shadow:0 0 0 3px rgba(10,132,255,.2); }
  #chat-send { background:var(--blue); border-radius:10px; font-weight:600; transition:background .15s, transform .08s; }
  #chat-send:hover { background:#0a76e6; } #chat-send:active { transform:scale(.96); }
`;
document.head.appendChild(css);

// ---------------------------------------------------------------------------
//  DOM
// ---------------------------------------------------------------------------
const topbar = document.getElementById('topbar');
const btnChat = document.createElement('button');
btnChat.className = 'btn';
btnChat.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/></svg><span>Chat</span>`;
btnChat.title = 'Chat öffnen';
topbar.appendChild(btnChat);

const panel = document.createElement('div');
panel.id = 'chat-panel';
panel.innerHTML = `
  <div id="chat-hd"><h2>💬 Chat</h2><span class="min" title="Minimieren">–</span></div>
  <div id="chat-msgs"></div>
  <div id="chat-foot">
    <textarea placeholder="Nachricht schreiben…" maxlength="2000"></textarea>
    <button id="chat-send">Senden</button>
  </div>`;
document.body.appendChild(panel);

const msgsEl = panel.querySelector('#chat-msgs');
const ta = panel.querySelector('#chat-foot textarea');

// ---------------------------------------------------------------------------
//  Zustand + Helpers
// ---------------------------------------------------------------------------
let sb = null;
const msgs = new Map();          // id -> row
let open = localStorage.getItem('chat_open') === '1';

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function colorFor(n) {
  const s = (n || 'Gast').trim().toLowerCase(); let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 68%, 64%)`;
}
function timeStr(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
function myName() { return localStorage.getItem('cmt_name') || 'Gast'; }

function setOpen(v) {
  open = v; panel.classList.toggle('open', v);
  btnChat.classList.toggle('active', v);
  localStorage.setItem('chat_open', v ? '1' : '0');
  if (v) setTimeout(() => ta.focus(), 60);
}
btnChat.addEventListener('click', () => setOpen(!open));
panel.querySelector('.min').addEventListener('click', () => setOpen(false));

// ---------------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------------
function render() {
  const arr = [...msgs.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (arr.length === 0) { msgsEl.innerHTML = `<div id="chat-empty">Noch keine Nachrichten.<br>Schreib die erste!</div>`; return; }
  const nearBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
  msgsEl.innerHTML = '';
  for (const m of arr) {
    const el = document.createElement('div');
    el.className = 'chat-m';
    el.innerHTML = `
      <div class="top">
        <span class="who" style="color:${colorFor(m.author)}">${esc(m.author || 'Gast')}</span>
        <span class="when">${timeStr(m.created_at)}</span>
        <span class="del" title="Nachricht löschen">löschen</span>
      </div>
      <div class="body">${esc(m.body)}</div>`;
    el.querySelector('.del').addEventListener('click', () => del(m.id));
    msgsEl.appendChild(el);
  }
  if (nearBottom) msgsEl.scrollTop = msgsEl.scrollHeight;
}

// ---------------------------------------------------------------------------
//  Supabase
// ---------------------------------------------------------------------------
async function init() {
  if (!CONFIGURED) { btnChat.title = 'Backend nicht konfiguriert'; return; }
  sb = createClient(URL, KEY, { auth: { persistSession: false }, realtime: { params: { eventsPerSecond: 5 } } });
  const { data, error } = await sb.from('chat_messages').select('*').order('created_at');
  if (error) { console.error('[chat] load', error); return; }
  for (const m of data) msgs.set(m.id, m);
  render(); msgsEl.scrollTop = msgsEl.scrollHeight;
  sb.channel('chat')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_messages' }, (p) => {
      if (p.eventType === 'INSERT') msgs.set(p.new.id, p.new);
      else if (p.eventType === 'DELETE') msgs.delete(p.old.id);
      render();
      if (p.eventType === 'INSERT' && !open) { btnChat.classList.add('active'); }
    })
    .subscribe();
}

async function send() {
  const body = ta.value.trim(); if (!body || !sb) return;
  ta.value = '';
  const { data, error } = await sb.from('chat_messages').insert({ author: myName(), body }).select().single();
  if (error) { alert('Senden fehlgeschlagen: ' + error.message); return; }
  msgs.set(data.id, data); render(); msgsEl.scrollTop = msgsEl.scrollHeight;
}
async function del(id) {
  msgs.delete(id); render();
  if (sb) await sb.from('chat_messages').delete().eq('id', id);
}

panel.querySelector('#chat-send').addEventListener('click', send);
ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

// ---------------------------------------------------------------------------
//  Start
// ---------------------------------------------------------------------------
if (open) setOpen(true);
init();
