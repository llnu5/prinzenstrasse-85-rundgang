# -*- coding: utf-8 -*-
# ===========================================================================
#  Prinzenstrasse-Rundgang -- Rhino-6 Publish & Manage (IronPython 2.7)
#  v2 -- menuegefuehrt (Rhino-Dialoge). Keine externe DLL, kein Kompilieren.
#
#  Aufruf in Rhino 6:  _RunPythonScript  ->  diese Datei
#  (sinnvoll: als Alias/Toolbar-Button hinterlegen, z.B. Alias "Publish")
#
#  Funktionen:
#   - Modell veroeffentlichen (neu) oder vorhandenes aktualisieren
#   - Layer-Auswahl (sichtbare vorausgewaehlt) | nur Auswahl | 3D-Scan separat
#   - Texturen mitladen (auf MAX_TEX verkleinert, JPEG)
#   - Polygon-Budget (Mesh.Reduce) + Texturgroesse  => Dateigroesse steuern
#   - Einheiten -> Meter (Messwerkzeug stimmt)
#   - Projekte verwalten: Liste / oeffnen / Link kopieren / umbenennen / loeschen
# ===========================================================================
import Rhino
import scriptcontext as sc
import rhinoscriptsyntax as rs
import System
import json, uuid, array, struct, os, re

import clr
for r in ['System.Drawing', 'System.Net', 'System.IO.Compression', 'System.IO.Compression.FileSystem']:
    try: clr.AddReference(r)
    except: pass
from System.Drawing import Bitmap, Rectangle, Graphics
from System.Drawing.Imaging import Encoder, EncoderParameter, EncoderParameters, ImageCodecInfo, ImageFormat, PixelFormat
from System.IO import MemoryStream
from System.IO.Compression import GZipStream, CompressionMode
from System.Net import HttpWebRequest, WebException
from System.Text import Encoding

# ---------------------------------------------------------------------------
#  KONFIG (oeffentliche Keys, RLS-geschuetzt -- identisch zur Web-App)
# ---------------------------------------------------------------------------
SUPABASE_URL = 'https://jjeoxzbfsnrnwpooabfw.supabase.co'
SUPABASE_KEY = 'sb_publishable_l4hAdP8VzaJ23vAPnv3BgA_52LkRXta'
STORAGE_BASE = SUPABASE_URL + '/storage/v1/object'
REST_BASE    = SUPABASE_URL + '/rest/v1'
VIEWER_BASE  = 'https://llnu5.github.io/prinzenstrasse-85-rundgang/index.html'
JPEG_QUALITY = 85

# Laufzeit-Einstellungen (per Menue gesetzt)
OPT = {'max_tex': 1024, 'poly_budget': 1000000, 'selected_only': False, 'layers': None}

def log(m): Rhino.RhinoApp.WriteLine('[publish] ' + m)

# ---------------------------------------------------------------------------
#  Layer-Logik (identisch zur Web-App)
# ---------------------------------------------------------------------------
def is_scan_layer(name):
    n = (name or '').strip().lower()
    return bool(re.search(r'3d[\s_-]?scan', n)) or n == 'scan'
def is_glass_layer(name):
    n = (name or '').lower()
    return ('glas' in n) or (u'gla\xdf' in n)
def is_hide_layer(name):
    return (name or '').strip().lower() == 'hide'

# ---------------------------------------------------------------------------
#  Texturen: Datei -> verkleinertes JPEG (bytes)
# ---------------------------------------------------------------------------
_jpeg_codec = None
def jpeg_codec():
    global _jpeg_codec
    if _jpeg_codec is None:
        for c in ImageCodecInfo.GetImageEncoders():
            if c.FormatID == ImageFormat.Jpeg.Guid: _jpeg_codec = c; break
    return _jpeg_codec

def load_resize_jpeg(path):
    try:
        if not path or not os.path.exists(path): return None
        src = Bitmap(path); w, h = src.Width, src.Height
        scale = 1.0; mx = OPT['max_tex']
        if max(w, h) > mx: scale = float(mx) / float(max(w, h))
        nw, nh = max(1, int(w*scale)), max(1, int(h*scale))
        dst = Bitmap(nw, nh, PixelFormat.Format24bppRgb)
        g = Graphics.FromImage(dst); g.DrawImage(src, Rectangle(0,0,nw,nh)); g.Dispose(); src.Dispose()
        ms = MemoryStream(); eps = EncoderParameters(1)
        eps.Param[0] = EncoderParameter(Encoder.Quality, System.Int64(JPEG_QUALITY))
        dst.Save(ms, jpeg_codec(), eps); dst.Dispose()
        b = ms.ToArray(); ms.Dispose(); return bytes(bytearray(b))
    except Exception as e:
        log('Textur-Fehler %s: %s' % (path, e)); return None

def material_of(obj):
    try: return obj.GetMaterial(True)
    except:
        try:
            mi = obj.Attributes.MaterialIndex
            if mi >= 0: return sc.doc.Materials[mi]
        except: pass
    return None
def material_texture_path(obj):
    mat = material_of(obj)
    if not mat: return None
    try:
        bt = mat.GetBitmapTexture()
        if bt and bt.FileName: return bt.FileName
    except: pass
    try:
        tx = mat.GetTexture(Rhino.DocObjects.TextureType.Bitmap)
        if tx and tx.FileName: return tx.FileName
    except: pass
    return None
def material_color(obj):
    mat = material_of(obj)
    if mat:
        try: c = mat.DiffuseColor; return [c.R/255.0, c.G/255.0, c.B/255.0]
        except: pass
    return [0.8, 0.8, 0.8]

# ---------------------------------------------------------------------------
#  Geometrie sammeln (Bloecke rekursiv aufloesen, Layer-Filter, Einheiten->m)
# ---------------------------------------------------------------------------
def layer_name_of(obj):
    try: return sc.doc.Layers[obj.Attributes.LayerIndex].Name
    except: return ''

def meshes_of_geometry(geo):
    out = []
    try:
        if isinstance(geo, Rhino.Geometry.Mesh):
            out.append(geo.DuplicateMesh())
        elif isinstance(geo, Rhino.Geometry.Brep):
            ms = Rhino.Geometry.Mesh.CreateFromBrep(geo, Rhino.Geometry.MeshingParameters.Default)
            if ms:
                for m in ms: out.append(m)
        elif isinstance(geo, Rhino.Geometry.Extrusion):
            br = geo.ToBrep(True)
            if br:
                ms = Rhino.Geometry.Mesh.CreateFromBrep(br, Rhino.Geometry.MeshingParameters.Default)
                if ms:
                    for m in ms: out.append(m)
    except Exception as e:
        log('Mesh-Fehler: %s' % e)
    return out

def collect(raw):
    """raw <- Liste {mesh, grp, gmat, tex, color}. Liefert stats-dict."""
    doc = sc.doc
    layers_ok = OPT['layers']         # None = alle, sonst set von Namen
    sel_only  = OPT['selected_only']
    tex_cache = {}
    stats = {'meshes':0,'scan':0,'glass':0,'hidden':0,'tex':0,'blocks':0}

    sel_ids = None
    if sel_only:
        sel_ids = set([str(o.Id) for o in doc.Objects if o.IsSelected(False)])

    def layer_allowed(lname):
        if layers_ok is not None and lname not in layers_ok: return False
        return True

    def add_object(obj, xform, inherit_layer):
        if isinstance(obj.Geometry, Rhino.Geometry.InstanceReferenceGeometry): return
        lname = layer_name_of(obj) or inherit_layer or ''
        if not layer_allowed(lname):
            return
        glass = is_glass_layer(lname); scan = is_scan_layer(lname)
        if not glass and not scan and is_hide_layer(lname):
            stats['hidden'] += 1; return
        meshes = meshes_of_geometry(obj.Geometry)
        if not meshes: return
        tex_key = None
        if not glass:
            tp = material_texture_path(obj)
            if tp:
                base = os.path.basename(tp).lower()
                if base not in tex_cache: tex_cache[base] = load_resize_jpeg(tp)
                if tex_cache.get(base): tex_key = base
        col = material_color(obj)
        for m in meshes:
            if xform and xform != Rhino.Geometry.Transform.Identity: m.Transform(xform)
            raw.append({'mesh':m,'grp':'scan' if scan else 'cad','gmat':'glass' if glass else '','tex':tex_key,'color':col})
            stats['meshes'] += 1
            if scan: stats['scan'] += 1
            if glass: stats['glass'] += 1
            if tex_key: stats['tex'] += 1

    def explode_instance(iobj, xform, inherit_layer):
        stats['blocks'] += 1
        try: xf = iobj.InstanceXform
        except: xf = Rhino.Geometry.Transform.Identity
        comb = Rhino.Geometry.Transform.Multiply(xform, xf) if xform else xf
        try: members = iobj.InstanceDefinition.GetObjects()
        except: members = []
        for mo in members:
            if isinstance(mo.Geometry, Rhino.Geometry.InstanceReferenceGeometry):
                explode_instance(mo, comb, inherit_layer)
            else:
                add_object(mo, comb, inherit_layer)

    for obj in doc.Objects:
        if not obj.IsValid: continue
        if obj.Geometry is None: continue
        if sel_ids is not None and str(obj.Id) not in sel_ids: continue
        if isinstance(obj, Rhino.DocObjects.InstanceObject):
            lname = layer_name_of(obj)
            if is_hide_layer(lname): stats['hidden'] += 1; continue
            if not layer_allowed(lname): continue
            explode_instance(obj, Rhino.Geometry.Transform.Identity, lname)
        else:
            add_object(obj, Rhino.Geometry.Transform.Identity, None)

    # Einheiten -> Meter
    factor = Rhino.RhinoMath.UnitScale(doc.ModelUnitSystem, Rhino.UnitSystem.Meters)
    if abs(factor - 1.0) > 1e-9:
        sx = Rhino.Geometry.Transform.Scale(Rhino.Geometry.Point3d.Origin, factor)
        for r in raw: r['mesh'].Transform(sx)
        log('Einheiten skaliert x%.4f -> Meter' % factor)

    # Polygon-Budget: grosse Meshes reduzieren
    budget = OPT['poly_budget']
    if budget and budget > 0:
        total = sum([r['mesh'].Faces.Count for r in raw])
        if total > budget:
            f = float(budget) / float(total)
            log('Polygon-Reduktion: %d -> ~%d (Faktor %.2f)' % (total, budget, f))
            for r in raw:
                try:
                    target = max(50, int(r['mesh'].Faces.Count * f))
                    if r['mesh'].Faces.Count > target: r['mesh'].Reduce(target, True, 10, False)
                except Exception as e: pass
    return stats, tex_cache

# ---------------------------------------------------------------------------
#  Rhino-Mesh -> Renderable (Z-up; Viewer dreht auf Y-up)
# ---------------------------------------------------------------------------
def mesh_to_renderable(m, meta):
    try:
        m.Faces.ConvertQuadsToTriangles()
        nv = m.Vertices.Count
        if nv == 0 or m.Faces.Count == 0: return None
        if m.Normals.Count != nv: m.Normals.ComputeNormals()
        pos = array.array('f'); nor = array.array('f'); uv = array.array('f')
        has_uv = (m.TextureCoordinates.Count == nv) and (meta['tex'] is not None)
        for i in range(nv):
            v = m.Vertices[i]; pos.append(float(v.X)); pos.append(float(v.Y)); pos.append(float(v.Z))
            if m.Normals.Count == nv:
                n = m.Normals[i]; nor.append(float(n.X)); nor.append(float(n.Y)); nor.append(float(n.Z))
            else: nor.append(0.0); nor.append(0.0); nor.append(1.0)
            if has_uv:
                t = m.TextureCoordinates[i]; uv.append(float(t.X)); uv.append(1.0 - float(t.Y))
            else: uv.append(0.0); uv.append(0.0)
        idx = array.array('I')
        for f in range(m.Faces.Count):
            face = m.Faces[f]
            idx.append(face.A); idx.append(face.B); idx.append(face.C)
            if face.IsQuad: idx.append(face.A); idx.append(face.C); idx.append(face.D)
        r = dict(meta); r.update({'pos':pos,'nor':nor,'uv':uv,'idx':idx,'has_uv':has_uv,'nv':nv})
        return r
    except Exception as e:
        log('mesh_to_renderable: %s' % e); return None

# ---------------------------------------------------------------------------
#  GLB von Hand bauen (gegen echten GLTFLoader validiert)
# ---------------------------------------------------------------------------
def _pad4(b, fill):
    while (len(b) % 4) != 0: b.append(fill)

def build_glb(renderables, tex_cache):
    buf = bytearray()
    bufferViews=[]; accessors=[]; images=[]; textures=[]; materials=[]; meshes=[]; nodes=[]
    img_index = {}
    for base, jb in tex_cache.items():
        if not jb: continue
        off=len(buf); buf.extend(bytearray(jb)); ln=len(jb); _pad4(buf,0)
        bufferViews.append({'buffer':0,'byteOffset':off,'byteLength':ln})
        images.append({'bufferView':len(bufferViews)-1,'mimeType':'image/jpeg'})
        textures.append({'source':len(images)-1}); img_index[base]=len(textures)-1

    def add_accessor(arr, ct, ts, count, mn=None, mx=None, target=None):
        raw = arr.tostring() if hasattr(arr,'tostring') else arr.tobytes()
        off=len(buf); buf.extend(bytearray(raw)); _pad4(buf,0)
        bv={'buffer':0,'byteOffset':off,'byteLength':len(raw)}
        if target: bv['target']=target
        bufferViews.append(bv)
        acc={'bufferView':len(bufferViews)-1,'componentType':ct,'count':count,'type':ts}
        if mn is not None: acc['min']=mn; acc['max']=mx
        accessors.append(acc); return len(accessors)-1

    mat_index={}
    def get_material(r):
        if r['gmat']=='glass':
            k='glass'
            if k not in mat_index:
                materials.append({'name':'glass','pbrMetallicRoughness':{'baseColorFactor':[0.75,0.88,0.93,0.26],'metallicFactor':0.0,'roughnessFactor':0.06},'alphaMode':'BLEND','doubleSided':True}); mat_index[k]=len(materials)-1
            return mat_index[k]
        if r['tex']:
            k='tex:'+r['tex']
            if k not in mat_index:
                materials.append({'name':r['tex'],'pbrMetallicRoughness':{'baseColorTexture':{'index':img_index[r['tex']]},'baseColorFactor':[1,1,1,1],'metallicFactor':0.0,'roughnessFactor':0.9},'doubleSided':True}); mat_index[k]=len(materials)-1
            return mat_index[k]
        c=r['color']; k='col:%0.2f_%0.2f_%0.2f'%(c[0],c[1],c[2])
        if k not in mat_index:
            materials.append({'name':'col','pbrMetallicRoughness':{'baseColorFactor':[c[0],c[1],c[2],1],'metallicFactor':0.0,'roughnessFactor':0.9},'doubleSided':True}); mat_index[k]=len(materials)-1
        return mat_index[k]

    CF=5126; CU=5125; AB=34962; EB=34963; node_indices=[]
    for r in renderables:
        nv=r['nv']; p=r['pos']; mnx=mny=mnz=1e30; mxx=mxy=mxz=-1e30
        for i in range(0,len(p),3):
            x,y,z=p[i],p[i+1],p[i+2]
            if x<mnx:mnx=x
            if y<mny:mny=y
            if z<mnz:mnz=z
            if x>mxx:mxx=x
            if y>mxy:mxy=y
            if z>mxz:mxz=z
        a_pos=add_accessor(r['pos'],CF,'VEC3',nv,[mnx,mny,mnz],[mxx,mxy,mxz],AB)
        a_nor=add_accessor(r['nor'],CF,'VEC3',nv,target=AB)
        attrs={'POSITION':a_pos,'NORMAL':a_nor}
        if r['has_uv']: attrs['TEXCOORD_0']=add_accessor(r['uv'],CF,'VEC2',nv,target=AB)
        a_idx=add_accessor(r['idx'],CU,'SCALAR',len(r['idx']),target=EB)
        meshes.append({'primitives':[{'attributes':attrs,'indices':a_idx,'material':get_material(r),'mode':4}]})
        nodes.append({'mesh':len(meshes)-1,'extras':{'grp':r['grp'],'gmat':r['gmat']}})
        node_indices.append(len(nodes)-1)

    gltf={'asset':{'version':'2.0','generator':'rhino_publish.py'},'scene':0,'scenes':[{'nodes':node_indices}],
          'nodes':nodes,'meshes':meshes,'materials':materials,'accessors':accessors,'bufferViews':bufferViews,
          'buffers':[{'byteLength':len(buf)}]}
    if images: gltf['images']=images
    if textures: gltf['textures']=textures
    jb=bytearray(Encoding.UTF8.GetBytes(json.dumps(gltf))); _pad4(jb,0x20); _pad4(buf,0x00)
    total=12+8+len(jb)+8+len(buf); out=bytearray()
    out.extend(struct.pack('<III',0x46546C67,2,total))
    out.extend(struct.pack('<II',len(jb),0x4E4F534A)); out.extend(jb)
    out.extend(struct.pack('<II',len(buf),0x004E4942)); out.extend(buf)
    return bytes(out)

def gzip_bytes(data):
    ms=MemoryStream(); gz=GZipStream(ms,CompressionMode.Compress,True)
    arr=System.Array[System.Byte](bytearray(data)); gz.Write(arr,0,arr.Length); gz.Close()
    out=ms.ToArray(); ms.Dispose(); return bytes(bytearray(out))

# ---------------------------------------------------------------------------
#  HTTP (Supabase)
# ---------------------------------------------------------------------------
def _auth(req):
    req.Headers.Add('apikey', SUPABASE_KEY); req.Headers.Add('Authorization', 'Bearer ' + SUPABASE_KEY)
def _read(req):
    resp=req.GetResponse(); sr=System.IO.StreamReader(resp.GetResponseStream()); t=sr.ReadToEnd(); sr.Close(); resp.Close(); return t
def _err_text(we):
    try:
        r=we.Response; sr=System.IO.StreamReader(r.GetResponseStream()); return sr.ReadToEnd()
    except: return str(we)

def rest_get(path):
    req=System.Net.WebRequest.Create(System.Uri(REST_BASE+path)); req.Method='GET'; _auth(req)
    try: return json.loads(_read(req))
    except Exception as e: log('REST GET: %s' % e); return None
def rest_json(path, method, row):
    body=Encoding.UTF8.GetBytes(json.dumps(row))
    req=System.Net.WebRequest.Create(System.Uri(REST_BASE+path)); req.Method=method; _auth(req)
    req.ContentType='application/json'; req.Headers.Add('Prefer','resolution=merge-duplicates,return=minimal')
    req.ContentLength=body.Length; st=req.GetRequestStream(); st.Write(body,0,body.Length); st.Close()
    try: _read(req); return True
    except WebException as we: log('REST %s: %s' % (method,_err_text(we))); return False
    except Exception as e: log('REST %s: %s' % (method,e)); return False
def rest_delete(path):
    req=System.Net.WebRequest.Create(System.Uri(REST_BASE+path)); req.Method='DELETE'; _auth(req)
    try: _read(req); return True
    except WebException as we: log('REST DELETE: %s' % _err_text(we)); return False
    except Exception as e: log('REST DELETE: %s' % e); return False

def storage_upload(path, data, content_type):
    body=System.Array[System.Byte](bytearray(data))
    req=System.Net.WebRequest.Create(System.Uri(STORAGE_BASE+'/models/'+path)); req.Method='POST'; _auth(req)
    req.Headers.Add('x-upsert','true'); req.ContentType=content_type; req.ContentLength=body.Length
    try:
        st=req.GetRequestStream(); st.Write(body,0,body.Length); st.Close(); _read(req); return None
    except WebException as we: return _err_text(we)
    except Exception as e: return str(e)
def storage_delete(path):
    req=System.Net.WebRequest.Create(System.Uri(STORAGE_BASE+'/models/'+path)); req.Method='DELETE'; _auth(req)
    try: _read(req); return True
    except: return False

# ---------------------------------------------------------------------------
#  Aktionen
# ---------------------------------------------------------------------------
def fetch_projects():
    rows = rest_get('/projects?select=id,name,type,version,has_2d_scan,file_path&order=created_at.desc')
    return rows or []

def do_publish():
    doc = sc.doc
    # Layer-Auswahl (sichtbare vorausgewaehlt)
    all_layers=[]; visible=[]
    for l in doc.Layers:
        if l.IsDeleted: continue
        all_layers.append(l.Name)
        if l.IsVisible: visible.append(l.Name)
    picked = rs.MultiListBox(all_layers, 'Layer einbeziehen (Standard: sichtbare). 3D-Scan-Layer separat erkannt.', 'Publish: Layer', visible)
    if picked is None: return
    OPT['layers'] = set(picked)

    # Nur Auswahl?
    OPT['selected_only'] = False
    if len([o for o in doc.Objects if o.IsSelected(False)]) > 0:
        OPT['selected_only'] = (rs.MessageBox('Nur die aktuelle Auswahl exportieren?', 4, 'Auswahl') == 6)

    # Polygon-Budget
    pb = rs.ListBox(['250000','500000','1000000','2000000','Unbegrenzt'], 'Polygon-Budget (kleiner = leichter/kleiner)', 'Publish: Polygone', '1000000')
    if pb is None: return
    OPT['poly_budget'] = 0 if pb=='Unbegrenzt' else int(pb)

    # Texturgroesse
    tm = rs.ListBox(['512','1024','2048'], 'Max. Texturgroesse (px)', 'Publish: Texturen', '1024')
    if tm is None: return
    OPT['max_tex'] = int(tm)

    # Projektname (neu oder vorhandenes aktualisieren)
    projects = fetch_projects()
    names = [p['name'] for p in projects]
    NEW = '[ Neues Projekt ... ]'
    pick = rs.ListBox([NEW] + names, 'Projekt: neu anlegen oder aktualisieren', 'Publish: Ziel')
    if pick is None: return
    if pick == NEW:
        name = rs.GetString('Neuer Projektname')
        if not name: return
        name = name.strip(); pid = str(uuid.uuid4()); version = 1
    else:
        p = [x for x in projects if x['name']==pick][0]
        name = pick; pid = p['id']; version = int(p.get('version',1))+1

    log('--- Sammle Geometrie & Texturen ---')
    raw=[]; (stats, tex_cache) = collect(raw)
    if not raw: log('Keine Geometrie (Layer-Auswahl pruefen).'); rs.MessageBox('Keine Geometrie gefunden.',0,'Publish'); return
    has_scan = stats['scan']>0
    log('Meshes %d | Scan %d | Glas %d | Texturen %d | Bloecke %d | versteckt %d' %
        (stats['meshes'],stats['scan'],stats['glass'],stats['tex'],stats['blocks'],stats['hidden']))

    renderables=[]
    for r in raw:
        rr = mesh_to_renderable(r['mesh'], r)
        if rr: renderables.append(rr)
    log('Baue GLB ...'); glb=build_glb(renderables, tex_cache)
    log('GLB %.1f MB | gzip ...' % (len(glb)/1048576.0))
    gz=gzip_bytes(glb); mb=len(gz)/1048576.0
    log('Upload-Groesse %.1f MB' % mb)
    if mb > 50:
        if rs.MessageBox('Datei ist %.1f MB > 50 MB (Supabase-Free lehnt ab).\n\nKleineres Polygon-Budget/Textur waehlen?\n(Ja=abbrechen)' % mb, 4, 'Zu gross') == 6:
            return

    path='projects/%s/model.glb.gz' % pid
    log('Lade hoch ...'); err=storage_upload(path, gz, 'application/gzip')
    if err: log('UPLOAD FEHLGESCHLAGEN (%.1f MB): %s' % (mb, err)); rs.MessageBox('Upload fehlgeschlagen (%.1f MB):\n%s' % (mb, err),0,'Fehler'); return

    row={'id':pid,'name':name,'type':'rhino','file_path':path,
         'file_name':os.path.basename(doc.Path or 'rhino.3dm'),'has_2d_scan':has_scan,'version':version}
    if not rest_json('/projects?on_conflict=id','POST',row):
        rs.MessageBox('Modell liegt im Storage, aber Projektzeile schlug fehl.',0,'Teilweise'); return

    url=VIEWER_BASE+'?p='+pid
    log('FERTIG -> '+url)
    if rs.MessageBox('Veroeffentlicht (%.1f MB)!\n\n%s\n\nIm Browser oeffnen?' % (mb, url), 4, 'Publish') == 6:
        try: System.Diagnostics.Process.Start(url)
        except: pass
    rs.ClipboardText(url)

def do_manage():
    while True:
        projects = fetch_projects()
        if not projects:
            rs.MessageBox('Noch keine Projekte online.',0,'Projekte'); return
        labels = ['%s  (v%d%s)' % (p['name'], p.get('version',1), ', Scan' if p.get('has_2d_scan') else '') for p in projects]
        sel = rs.ListBox(labels, 'Projekt waehlen (Verwaltung)', 'Projekte online')
        if sel is None: return
        p = projects[labels.index(sel)]
        action = rs.ListBox(['Im Browser oeffnen','Link kopieren','Umbenennen','Loeschen','Zurueck'], p['name'], 'Aktion')
        if action is None or action == 'Zurueck': continue
        url = VIEWER_BASE+'?p='+p['id']
        if action == 'Im Browser oeffnen':
            try: System.Diagnostics.Process.Start(url)
            except Exception as e: log('Oeffnen: %s' % e)
        elif action == 'Link kopieren':
            rs.ClipboardText(url); rs.MessageBox('Link kopiert:\n'+url,0,'Link')
        elif action == 'Umbenennen':
            nn = rs.GetString('Neuer Name', p['name'])
            if nn and nn.strip():
                if rest_json('/projects?id=eq.'+p['id'],'PATCH',{'name':nn.strip()}): log('Umbenannt -> '+nn)
        elif action == 'Loeschen':
            if rs.MessageBox('Projekt "%s" wirklich loeschen? (Annotationen bleiben in DB, Modell wird entfernt)' % p['name'], 4, 'Loeschen') == 6:
                storage_delete(p.get('file_path',''))
                if rest_delete('/projects?id=eq.'+p['id']): log('Geloescht: '+p['name'])

def main():
    choice = rs.ListBox(['Modell veroeffentlichen','Projekte verwalten','Abbrechen'],
                        'Prinzenstrasse-Rundgang', 'Publish & Manage')
    if not choice or choice == 'Abbrechen': return
    if choice == 'Modell veroeffentlichen': do_publish()
    else: do_manage()

main()
