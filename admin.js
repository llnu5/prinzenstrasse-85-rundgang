// ===========================================================================
//  Admin – Projekte anlegen/aktualisieren (Matterport-ZIP oder Rhino-.3dm)
//  Hinweis: Das Passwort-Gate ist clientseitig und NICHT echt geheim.
// ===========================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = window.SUPABASE_URL, KEY = window.SUPABASE_ANON_KEY;
const sb = createClient(URL, KEY, { auth: { persistSession: false } });
const ADMIN_PW = 'Berl1nus';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
//  Login-Gate
// ---------------------------------------------------------------------------
function showPanel() { $('login').classList.add('hidden'); $('panel').classList.remove('hidden'); renderList(); }
function tryLogin() {
  if ($('pw').value === ADMIN_PW) { sessionStorage.setItem('admin_ok', '1'); showPanel(); }
  else { $('login-err').textContent = 'Falsches Passwort.'; }
}
$('login-btn').addEventListener('click', tryLogin);
$('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
$('logout').addEventListener('click', () => { sessionStorage.removeItem('admin_ok'); location.reload(); });
if (sessionStorage.getItem('admin_ok') === '1') showPanel();
else setTimeout(() => $('pw').focus(), 100);

// ---------------------------------------------------------------------------
//  Datei-Auswahl
// ---------------------------------------------------------------------------
let chosenFile = null;
let editing = null;            // Projekt das aktualisiert wird

const drop = $('drop'), fileInput = $('file');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

function typeOf(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  return ext === '3dm' ? 'rhino' : ext === 'zip' ? 'matterport' : null;
}
function setFile(file) {
  if (!typeOf(file)) { alert('Bitte eine .zip (Matterport) oder .3dm (Rhino) Datei wählen.'); return; }
  chosenFile = file;
  $('fname').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} MB · ${typeOf(file) === 'rhino' ? 'Rhino' : 'Matterport'}`;
  $('upload-btn').disabled = false;
}

// ---------------------------------------------------------------------------
//  Rhino: Layer "3D_Scan" erkennen
// ---------------------------------------------------------------------------
let _rhino;
async function rhinoModule() {
  if (!_rhino) { const m = await import('https://cdn.jsdelivr.net/npm/rhino3dm@8.4.0/rhino3dm.module.js'); _rhino = await m.default(); }
  return _rhino;
}
// Rhino verarbeiten: Layer "3D_Scan" erkennen UND Block-Instanzen (z. B.
// VisualARQ-Stützen) rekursiv in Solids auflösen, damit der 3DMLoader sie zeigt.
async function processRhino(file) {
  const rhino = await rhinoModule();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(await file.arrayBuffer()));
  if (!doc) return { has3dScan: false, bytes: null, added: 0 };

  // 3D_Scan-Layer?  (count ist eine Property, keine Funktion!)
  const layers = doc.layers(); let has3dScan = false;
  for (let i = 0; i < layers.count; i++) {
    const l = layers.get(i);
    if ((l.name || '').trim().toLowerCase() === '3d_scan') has3dScan = true;
  }

  let res = { added: 0, skipped: 0 };
  try { res = explodeInstances(rhino, doc) || res; }
  catch (e) { console.warn('[admin] Block-Auflösen fehlgeschlagen', e); }

  const bytes = doc.toByteArray();
  return { has3dScan, bytes, added: res.added, skipped: res.skipped };
}

// Instanz-Referenzen (Blöcke) rekursiv auflösen: Definitions-Geometrie geklont,
// an die (verkettete) Instanz-Transformation gesetzt, der Objekttabelle hinzufügen.
// WICHTIG: jede Member-Geometrie KLONEN, sonst summieren sich Transformationen
// über geteilte Definitionen (Objekte würden im Raum verstreut).
function explodeInstances(rhino, doc) {
  const objs = doc.objects(), idefs = doc.instanceDefinitions();
  const N = objs.count;

  // Layer, die bereits direkte Körper enthalten -> dort NICHT auflösen (keine Doppelung)
  const directSolidLayers = new Set();
  for (let i = 0; i < N; i++) {
    const o = objs.get(i); if (!o) continue; const g = o.geometry(); if (!g) continue;
    const t = g.constructor.name;
    if (t.includes('Brep') || t.includes('Extrusion') || t.includes('Mesh')) directSolidLayers.add(o.attributes().layerIndex);
  }

  // Dedup-Signaturen aus vorhandenen Körpern (gleiche Position+Größe -> nicht doppeln)
  const sig = (bb) => { const q = (v) => Math.round(v / 25); return [q((bb.min[0] + bb.max[0]) / 2), q((bb.min[1] + bb.max[1]) / 2), q((bb.min[2] + bb.max[2]) / 2), q(bb.max[0] - bb.min[0]), q(bb.max[1] - bb.min[1]), q(bb.max[2] - bb.min[2])].join(','); };
  const occupied = new Set();
  for (let i = 0; i < N; i++) { const o = objs.get(i); if (!o) continue; const g = o.geometry(); if (!g) continue; const t = g.constructor.name; if (t.includes('Brep') || t.includes('Extrusion') || t.includes('Mesh')) { try { occupied.add(sig(g.getBoundingBox())); } catch (e) {} } }

  const idefById = {};
  for (let i = 0; i < idefs.count; i++) { const d = idefs.get(i); idefById[d.id] = d.getObjectIds ? d.getObjectIds() : []; }
  const idxById = {};
  for (let i = 0; i < N; i++) { const o = objs.get(i); if (o) idxById[o.attributes().id] = i; }
  const clone = (g) => rhino.CommonObject.decode(g.encode());
  // Layer-Namen + Sichtbarkeit (Eigen-Ebene der Unterobjekte erhalten; ausgeblendete Instanzen überspringen)
  const layerName = {}, layerVisible = {};
  // Hinweis: die .3dm-visible-Flagge ist bei VisualARQ teils unzuverlässig.
  // Daher gilt zusätzlich: ein Layer namens "hide" ist IMMER ausgeblendet.
  { const L = doc.layers(); for (let i = 0; i < L.count; i++) { const l = L.get(i); const nm = (l.name || ''); layerName[i] = nm; layerVisible[i] = l.visible !== false && nm.trim().toLowerCase() !== 'hide'; } }
  let added = 0, skipped = 0;

  function addSolid(g, layerIndex, xforms) {
    const mg = clone(g);                                   // <- klonen, sonst summieren sich Transformationen!
    for (let k = xforms.length - 1; k >= 0; k--) { if (!mg.transform(xforms[k])) return; }
    const t = mg.constructor.name;
    if (!(t.includes('Extrusion') || t.includes('Brep') || t.includes('Mesh'))) return;
    let s; try { s = sig(mg.getBoundingBox()); } catch (e) { s = null; }
    if (s && occupied.has(s)) return;                      // Doppelung vermeiden
    if (s) occupied.add(s);
    const a = new rhino.ObjectAttributes(); a.layerIndex = layerIndex;
    if (t.includes('Extrusion')) { if (!objs.addExtrusion(mg, a)) { try { const b = mg.toBrep(true); if (b) objs.addBrep(b, a); } catch (e) { return; } } added++; }
    else if (t.includes('Brep')) { objs.addBrep(mg, a); added++; }
    else if (t.includes('Mesh')) { objs.addMesh(mg, a); added++; }
  }
  function ex(defId, inheritedLayer, xforms, depth) {
    if (depth > 6) return;
    for (const mid of (idefById[defId] || [])) {
      const idx = idxById[mid]; if (idx == null) continue;
      const src = objs.get(idx); if (!src) continue;
      const g = src.geometry(); if (!g) continue;
      // Eigen-Ebene des Unterobjekts erhalten (Glas-Scheiben bleiben auf "Glass");
      // "By Parent"/leer -> Ebene der übergeordneten Instanz erben.
      const memIdx = src.attributes().layerIndex;
      const memName = (layerName[memIdx] || '').toLowerCase();
      const eff = (memName === 'by parent' || memName === 'byparent' || memName === '') ? inheritedLayer : memIdx;
      if (g.constructor.name === 'InstanceReference') {
        if (layerVisible[memIdx] === false) { skipped++; continue; }   // verschachtelter Block in Rhino ausgeblendet
        ex(g.parentIdefId, eff, [...xforms, g.xform], depth + 1);
      } else addSolid(g, eff, xforms);
    }
  }
  for (let i = 0; i < N; i++) {
    const o = objs.get(i); if (!o) continue;
    const g = o.geometry(); if (!g || g.constructor.name !== 'InstanceReference') continue;
    const li = o.attributes().layerIndex;
    if (directSolidLayers.has(li)) continue;               // Doppelung vermeiden
    if (layerVisible[li] === false) { skipped++; continue; }   // Instanz in Rhino ausgeblendet -> nicht zeigen
    ex(g.parentIdefId, li, [g.xform], 1);
  }
  return { added, skipped };
}

// ---------------------------------------------------------------------------
//  Upload / Anlegen / Aktualisieren
// ---------------------------------------------------------------------------
function setStatus(t, ok) { const s = $('status'); s.textContent = t; s.style.color = ok ? 'var(--green)' : 'var(--label2)'; }

// Upload: kleine Dateien Standard, große stückweise (resumable/TUS) -> robust & größer
async function uploadToStorage(path, data, contentType) {
  if (data.size <= 6 * 1024 * 1024) {
    const { error } = await sb.storage.from('models').upload(path, data, { upsert: true, contentType });
    return error ? error.message : null;
  }
  try {
    const tus = await import('https://cdn.jsdelivr.net/npm/tus-js-client@4.1.0/+esm');
    const Upload = tus.Upload || (tus.default && tus.default.Upload);
    return await new Promise((resolve) => {
      const up = new Upload(data, {
        endpoint: `${URL}/storage/v1/upload/resumable`,
        retryDelays: [0, 2000, 5000, 10000, 20000],
        headers: { authorization: `Bearer ${KEY}`, apikey: KEY, 'x-upsert': 'true' },
        uploadDataDuringCreation: true, removeFingerprintOnSuccess: true,
        chunkSize: 6 * 1024 * 1024,
        metadata: { bucketName: 'models', objectName: path, contentType, cacheControl: '3600' },
        onError: (e) => resolve((e && e.message) || String(e)),
        onProgress: (sent, total) => setStatus(`Lade hoch … ${Math.round((sent / total) * 100)} % (${(total / 1048576).toFixed(0)} MB)`),
        onSuccess: () => resolve(null),
      });
      up.findPreviousUploads().then((prev) => { if (prev.length) up.resumeFromPreviousUpload(prev[0]); up.start(); });
    });
  } catch (e) { return (e && e.message) || String(e); }
}

$('upload-btn').addEventListener('click', async () => {
  const name = $('pname').value.trim();
  if (!name) { alert('Bitte Projektnamen eingeben.'); return; }
  if (!chosenFile) { alert('Bitte Datei wählen.'); return; }
  const file = chosenFile, type = typeOf(file);
  $('upload-btn').disabled = true;

  let has2d = false;
  let uploadData = file;
  if (type === 'rhino') {
    setStatus('Verarbeite Rhino: Layer prüfen & Blöcke (Stützen etc.) auflösen …');
    const pr = await processRhino(file);
    has2d = pr.has3dScan;
    if (pr.bytes) uploadData = new Blob([pr.bytes], { type: 'model/3dm' });
    console.log(`[admin BUILD 23] Rhino: ${pr.added} Solids aufgelöst · ${pr.skipped} ausgeblendete Blöcke übersprungen · 3D_Scan=${has2d}`);
    setStatus(`Verarbeitet: ${pr.added} Solids · ${pr.skipped} versteckte Blöcke ausgelassen. Lade hoch …`);
  }

  const id = editing ? editing.id : crypto.randomUUID();
  const ext = file.name.split('.').pop().toLowerCase();
  const path = `projects/${id}/model.${ext}`;

  setStatus(`Lade hoch (${(uploadData.size / 1048576).toFixed(0)} MB) … das kann dauern.`);
  const upErr = await uploadToStorage(path, uploadData, type === 'rhino' ? 'model/3dm' : (file.type || 'application/zip'));
  if (upErr) { setStatus('Upload fehlgeschlagen: ' + upErr); $('upload-btn').disabled = false; return; }

  if (editing) {
    const { error } = await sb.from('projects').update({
      type, file_path: path, file_name: file.name, has_2d_scan: has2d, version: (editing.version || 1) + 1,
    }).eq('id', id);
    if (error) { setStatus('Fehler: ' + error.message); $('upload-btn').disabled = false; return; }
    setStatus('Projekt aktualisiert ✓ – Annotationen bleiben erhalten.', true);
  } else {
    const { error } = await sb.from('projects').insert({ id, name, type, file_path: path, file_name: file.name, has_2d_scan: has2d });
    if (error) { setStatus('Fehler: ' + error.message); $('upload-btn').disabled = false; return; }
    setStatus('Projekt angelegt ✓', true);
  }
  resetForm(); renderList();
});

$('cancel-edit').addEventListener('click', resetForm);
function resetForm() {
  editing = null; chosenFile = null; fileInput.value = '';
  $('pname').value = ''; $('fname').textContent = ''; $('upload-btn').disabled = true;
  $('pname').disabled = false;
  $('form-title').textContent = 'Neues Projekt';
  $('upload-btn').textContent = 'Hochladen & anlegen';
  $('cancel-edit').classList.add('hidden');
}
function startEdit(p) {
  editing = p; chosenFile = null; fileInput.value = '';
  $('pname').value = p.name; $('pname').disabled = true;
  $('fname').textContent = 'Neue Datei wählen, um zu überschreiben…';
  $('upload-btn').disabled = true;
  $('form-title').textContent = `„${p.name}" aktualisieren (Annotationen bleiben)`;
  $('upload-btn').textContent = 'Neue Version hochladen';
  $('cancel-edit').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
//  Liste
// ---------------------------------------------------------------------------
async function renderList() {
  const list = $('list');
  const { data, error } = await sb.from('projects').select('*').order('created_at', { ascending: false });
  if (error) { list.innerHTML = `<div class="err">${error.message}</div>`; return; }
  if (!data.length) { list.innerHTML = `<div class="sub">Noch keine Projekte. Lade oben das erste hoch.</div>`; return; }
  list.innerHTML = '';
  for (const p of data) {
    const el = document.createElement('div'); el.className = 'proj';
    const link = `${location.origin}${location.pathname.replace(/admin\.html$/, 'index.html')}?p=${p.id}`;
    el.innerHTML = `
      <div class="ic">${p.type === 'rhino' ? '◳' : '⬢'}</div>
      <div class="meta">
        <div class="nm">${escapeHtml(p.name)}${p.has_2d_scan ? '<span class="tag">3D_Scan</span>' : ''}</div>
        <div class="det">${p.type === 'rhino' ? 'Rhino' : 'Matterport'} · v${p.version} · ${escapeHtml(p.file_name || '')}</div>
        <div class="det"><a href="${link}" target="_blank">${link}</a></div>
      </div>
      <button class="btn sec" data-edit>Update</button>
      <button class="btn danger" data-del>Löschen</button>`;
    el.querySelector('[data-edit]').addEventListener('click', () => startEdit(p));
    el.querySelector('[data-del]').addEventListener('click', () => del(p));
    list.appendChild(el);
  }
}
async function del(p) {
  if (!confirm(`Projekt „${p.name}" inkl. Datei und allen Annotationen löschen?`)) return;
  if (p.file_path) await sb.storage.from('models').remove([p.file_path]);
  for (const t of ['threads', 'comments', 'measurements', 'bookmarks', 'chat_messages'])
    await sb.from(t).delete().eq('project_id', p.id);
  await sb.from('projects').delete().eq('id', p.id);
  renderList();
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
