# -*- coding: utf-8 -*-
# ===========================================================================
#  Dreihoch Metaverse -- Rhino Publish & Manage
#  Eto panel (project list + versions, 1-click update via .3dm link, start camera,
#  custom texture mapping). Menu fallback. No external DLL.
#  Works in Rhino 6, 7 and 8 (IronPython 2.7 / .NET).
#
#  Run in Rhino:  _RunPythonScript  ->  this file
#  (the commands "Publish" and "PublishUpload" are registered automatically)
#
#  Features:
#   - Publish a model (new) or update an existing one (1-click)
#   - Visible layers + 3D scan layer (auto, even if off); textures baked as JPEG
#   - Polygon budget (Mesh.Reduce) + texture size  => control file size
#   - Units -> meters (so the measure tool is correct)
#   - Manage projects: list / open / link / delete
# ===========================================================================
import Rhino
import scriptcontext as sc
import rhinoscriptsyntax as rs
import System
import json, uuid, array, struct, os, re, math

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
PLUGIN_VERSION = '1.0'
SUPABASE_URL = 'https://jjeoxzbfsnrnwpooabfw.supabase.co'
SUPABASE_KEY = 'sb_publishable_l4hAdP8VzaJ23vAPnv3BgA_52LkRXta'
STORAGE_BASE = SUPABASE_URL + '/storage/v1/object'
REST_BASE    = SUPABASE_URL + '/rest/v1'
WEB_BASE     = 'https://llnu5.github.io/dreihoch-metaverse/'
VIEWER_BASE  = WEB_BASE + 'index.html'
ADMIN_URL    = WEB_BASE + 'admin.html'
JPEG_QUALITY = 85

# Laufzeit-Einstellungen (per Panel gesetzt)
OPT = {'max_tex': 1024, 'poly_budget': 1000000, 'selected_only': False, 'layers': None,
       'textures': True, 'materials': True}
DEFAULT_COL = [0.82, 0.82, 0.82]

def log(m): Rhino.RhinoApp.WriteLine('[publish] ' + m)

# Fortschritts-Callback (vom Panel gesetzt) -> Status/Progressbar
_PROGRESS = [None]
def emit(m):
    log(m); cb = _PROGRESS[0]
    if cb:
        try: cb(m)
        except: pass

def open_url(url):
    """Browser oeffnen -- .NET Core/Rhino8 braucht UseShellExecute=True."""
    try:
        psi = System.Diagnostics.ProcessStartInfo(url); psi.UseShellExecute = True
        System.Diagnostics.Process.Start(psi); return True
    except Exception as e:
        try: System.Diagnostics.Process.Start(url); return True
        except Exception as e2: log('open_url: %s' % e2); return False

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

def material_texture(obj):
    """Diffuse-Bitmap-Textur (Texture-Objekt, fuer Dateiname + UVW-Transform)."""
    mat = material_of(obj)
    if not mat: return None
    try:
        bt = mat.GetBitmapTexture()
        if bt and bt.FileName: return bt
    except: pass
    try:
        tx = mat.GetTexture(Rhino.DocObjects.TextureType.Bitmap)
        if tx and tx.FileName: return tx
    except: pass
    return None

def bake_uvw(mesh, tex):
    """Repeat/Offset/Rotation der Textur (UvwTransform) in die Mesh-UVs backen,
    damit der Browser wie Rhino samplet (sonst gestaucht/verschoben)."""
    try:
        u = tex.UvwTransform
        a, b, e = u.M00, u.M01, u.M03
        c, d, f = u.M10, u.M11, u.M13
        if a == 1 and b == 0 and e == 0 and c == 0 and d == 1 and f == 0: return  # Identitaet
        tc = mesh.TextureCoordinates; n = tc.Count
        for i in range(n):
            p = tc[i]; x = p.X; y = p.Y
            tc[i] = Rhino.Geometry.Point2f(a*x + b*y + e, c*x + d*y + f)
    except: pass

# ---------------------------------------------------------------------------
#  Geometrie sammeln (Bloecke rekursiv aufloesen, Layer-Filter, Einheiten->m)
# ---------------------------------------------------------------------------
def layer_name_of(obj):
    try: return sc.doc.Layers[obj.Attributes.LayerIndex].Name
    except: return ''

def _mesh_brep(g):
    out = []
    if isinstance(g, Rhino.Geometry.Brep):
        ms = Rhino.Geometry.Mesh.CreateFromBrep(g, Rhino.Geometry.MeshingParameters.Default)
        if ms:
            for m in ms: out.append(m)
    elif isinstance(g, Rhino.Geometry.Extrusion):
        br = g.ToBrep(True)
        if br:
            ms = Rhino.Geometry.Mesh.CreateFromBrep(br, Rhino.Geometry.MeshingParameters.Default)
            if ms:
                for m in ms: out.append(m)
    return out

def meshes_of_object(obj, textured=False):
    """Texturiert -> RENDER-Mesh (korrekte Mapping-UVs). Untexturiert -> CreateFromBrep
    (robust, auch fuer ungueltige Breps mit kaputtem Render-Mesh)."""
    out = []
    try:
        g = obj.Geometry
        if isinstance(g, Rhino.Geometry.Mesh):
            out.append(g.DuplicateMesh()); return out      # Scan: gebackene UVs behalten
        if textured:
            rm = obj.GetMeshes(Rhino.Geometry.MeshType.Render)
            if not rm or len(rm) == 0:
                try: obj.CreateMeshes(Rhino.Geometry.MeshType.Render, Rhino.Geometry.MeshingParameters.Default, False)
                except: pass
                rm = obj.GetMeshes(Rhino.Geometry.MeshType.Render)
            if rm and len(rm) > 0:
                for m in rm:
                    if m and m.Vertices.Count > 0: out.append(m.DuplicateMesh())
                if out: return out
        # untexturiert ODER kein Render-Mesh -> robust selbst vernetzen
        out = _mesh_brep(g)
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
        if is_scan_layer(lname): return True          # Scan-Layer IMMER mit (auch wenn in Rhino aus)
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
        # Textur zuerst (entscheidet, ob Render-Mesh fuer UVs noetig ist)
        tex_key = None; tex_obj = None
        if not glass and OPT.get('textures', True):
            tex_obj = material_texture(obj)
            if tex_obj and tex_obj.FileName:
                base = os.path.basename(tex_obj.FileName).lower()
                if base not in tex_cache: tex_cache[base] = load_resize_jpeg(tex_obj.FileName)
                if tex_cache.get(base): tex_key = base
        meshes = meshes_of_object(obj, tex_key is not None)
        if not meshes: return
        col = material_color(obj) if OPT.get('materials', True) else DEFAULT_COL
        for m in meshes:
            if tex_key and tex_obj is not None: bake_uvw(m, tex_obj)   # Repeat/Offset in UVs backen
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

    # VOLLE Enumeration inkl. ausgeblendeter Objekte -> sonst fehlt z.B. der ausgeschaltete 3D-Scan-Layer!
    st = Rhino.DocObjects.ObjectEnumeratorSettings()
    st.NormalObjects = True; st.HiddenObjects = True; st.LockedObjects = True
    st.IncludeLights = False; st.IncludeGrips = False; st.DeletedObjects = False
    objlist = doc.Objects.GetObjectList(st)
    _n = 0
    for obj in objlist:
        _n += 1
        if _n % 3000 == 0: emit('Collecting geometry ... %d objects, %d meshes' % (_n, stats['meshes']))
        if not obj.IsValid: continue
        if obj.Geometry is None: continue
        if sel_ids is not None and str(obj.Id) not in sel_ids: continue
        lname = layer_name_of(obj)
        scan = is_scan_layer(lname)
        # Volle Enumeration zieht auch _Hide-Geometrie (andere Geschosse weit weg) rein ->
        # einzeln ausgeblendete / auf unsichtbarem Layer liegende NICHT-Scan-Objekte ueberspringen.
        if not scan:
            try:
                li = obj.Attributes.LayerIndex
                if obj.IsHidden or (li >= 0 and not doc.Layers[li].IsVisible):
                    stats['hidden'] += 1; continue
            except: pass
        if isinstance(obj, Rhino.DocObjects.InstanceObject):
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
    return stats, tex_cache

# Meshes nach Material zusammenfuehren (statt 1 Node pro Quell-Mesh) + Polygon-Budget.
def merge_and_extract(raw):
    buckets = {}   # key -> [Mesh, meta]
    for r in raw:
        c = r['color']
        if r['tex']:
            key = ('t', r['grp'], r['gmat'], r['tex'])
        else:
            key = ('c', r['grp'], r['gmat'], (int(round(c[0]*20)), int(round(c[1]*20)), int(round(c[2]*20))))
        if key not in buckets: buckets[key] = [Rhino.Geometry.Mesh(), r]
        buckets[key][0].Append(r['mesh'])
    budget = OPT['poly_budget']
    total = sum(b[0].Faces.Count for b in buckets.values())
    if budget and budget > 0 and total > budget:
        f = float(budget) / float(total)
        log('Polygon-Reduktion: %d -> ~%d' % (total, budget))
        for b in buckets.values():
            try:
                tgt = max(50, int(b[0].Faces.Count * f))
                if b[0].Faces.Count > tgt: b[0].Reduce(tgt, True, 10, False)
            except: pass
    rends = []
    for (mesh, meta) in buckets.values():
        rr = mesh_to_renderable(mesh, meta)
        if rr: rends.append(rr)
    log('Zusammengefuehrt: %d Quell-Meshes -> %d Material-Gruppen' % (len(raw), len(rends)))
    return rends

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
def capture_camera():
    """Aktive Rhino-Kamera -> Viewer-Szene (Z-up cm -> Meter, rotateX(-90): (x,y,z)->(x,z,-y))."""
    try:
        vp = sc.doc.Views.ActiveView.ActiveViewport
        loc = vp.CameraLocation; d = vp.CameraDirection
        f = Rhino.RhinoMath.UnitScale(sc.doc.ModelUnitSystem, Rhino.UnitSystem.Meters)
        def conv(p): return [round(p.X*f, 4), round(p.Z*f, 4), round(-p.Y*f, 4)]
        # Blickrichtung normieren und Target 10 m voraus setzen (CameraDirection ist ~Einheitsvektor)
        ll = math.sqrt(d.X*d.X + d.Y*d.Y + d.Z*d.Z) or 1.0
        step = 10.0 / (f if f else 1.0)   # 10 m in Modell-Einheiten
        tgt = Rhino.Geometry.Point3d(loc.X + d.X/ll*step, loc.Y + d.Y/ll*step, loc.Z + d.Z/ll*step)
        lens = vp.Camera35mmLensLength
        fov = 2.0 * math.degrees(math.atan(12.0 / lens)) if (lens and lens > 0) else 50.0
        return {'pos': conv(loc), 'target': conv(tgt), 'fov': round(fov, 2)}
    except Exception as e:
        log('Kamera-Capture: %s' % e); return None

def fetch_projects():
    rows = rest_get('/projects?select=id,name,type,version,has_2d_scan,file_path,settings&order=created_at.desc')
    return rows or []

# ---------------------------------------------------------------------------
#  .3dm-Verknuepfung (welches Online-Projekt gehoert zu dieser Datei) + Einstellungen
# ---------------------------------------------------------------------------
def link_get():
    d = sc.doc
    try:
        pid = d.Strings.GetValue('pr85_project_id'); name = d.Strings.GetValue('pr85_project_name')
        if pid: return {'id': pid, 'name': name or '?',
                        'budget': d.Strings.GetValue('pr85_budget'), 'tex': d.Strings.GetValue('pr85_tex'),
                        'layers': d.Strings.GetValue('pr85_layers')}
    except: pass
    return None
def link_set(pid, name, budget, tex, layers_csv):
    d = sc.doc
    try:
        d.Strings.SetString('pr85_project_id', pid); d.Strings.SetString('pr85_project_name', name)
        d.Strings.SetString('pr85_budget', str(budget)); d.Strings.SetString('pr85_tex', str(tex))
        d.Strings.SetString('pr85_layers', layers_csv or '')
    except Exception as e: log('link_set: %s' % e)
def link_clear():
    d = sc.doc
    for k in ['pr85_project_id', 'pr85_project_name', 'pr85_budget', 'pr85_tex', 'pr85_layers']:
        try: d.Strings.Delete(k)
        except: pass

def doc_scan_info():
    """Erkennt der offenen Datei einen 3D-Scan-Layer mit Geometrie? -> Anzahl Scan-Meshes."""
    try:
        doc = sc.doc; scan_idx = set()
        for i in range(doc.Layers.Count):
            l = doc.Layers[i]
            if not l.IsDeleted and is_scan_layer(l.Name): scan_idx.add(l.Index)
        if not scan_idx: return 0
        st = Rhino.DocObjects.ObjectEnumeratorSettings()
        st.NormalObjects = True; st.HiddenObjects = True; st.LockedObjects = True
        n = 0
        for o in doc.Objects.GetObjectList(st):
            if o.Attributes.LayerIndex in scan_idx and isinstance(o.Geometry, Rhino.Geometry.Mesh): n += 1
        return n
    except: return 0

# ---------------------------------------------------------------------------
#  Export-Kern (keine Dialoge) -> von Menue UND Panel genutzt
# ---------------------------------------------------------------------------
def export_and_upload(name, pid, version, budget, texmax, use_tex, use_mat, existing_settings, status=None):
    def st(m):
        emit(m)
    doc = sc.doc
    OPT['layers'] = None; OPT['poly_budget'] = budget; OPT['max_tex'] = texmax; OPT['selected_only'] = False
    OPT['textures'] = bool(use_tex); OPT['materials'] = bool(use_mat)
    _PROGRESS[0] = status
    try:
        cam = capture_camera()
        st('Collecting geometry & textures ...')
        raw = []; (stats, tex_cache) = collect(raw)
        if not raw: return (False, 'No visible geometry found.', 0, None)
        st('Processing: %d meshes (scan %d, glass %d, tex %d, blocks %d) ...' % (stats['meshes'], stats['scan'], stats['glass'], stats['tex'], stats['blocks']))
        renderables = merge_and_extract(raw)
        if not renderables: return (False, 'No meshes after merge.', 0, None)
        st('Building GLB ...'); glb = build_glb(renderables, tex_cache)
        st('Compressing (gzip) ...'); gz = gzip_bytes(glb); mb = len(gz) / 1048576.0
        if mb > 50:
            return (False, 'File %.1f MB > 50 MB (Supabase Free).\nChoose a smaller budget/texture, or turn textures off.' % mb, mb, None)
        settings = dict(existing_settings) if isinstance(existing_settings, dict) else {}
        if cam: settings['start_camera'] = cam
        path = 'projects/%s/model.glb.gz' % pid
        st('Uploading (%.1f MB) ... please wait' % mb)
        err = storage_upload(path, gz, 'application/gzip')
        if err: return (False, 'Upload failed: ' + err, mb, None)
        st('Writing project data ...')
        row = {'id': pid, 'name': name, 'type': 'rhino', 'file_path': path,
               'file_name': os.path.basename(doc.Path or 'rhino.3dm'), 'has_2d_scan': stats['scan'] > 0,
               'version': version, 'settings': settings}
        if not rest_json('/projects?on_conflict=id', 'POST', row):
            return (False, 'Storage ok, but writing the project row failed.', mb, None)
        return (True, VIEWER_BASE + '?p=' + pid, mb, {'has_scan': stats['scan'] > 0})
    finally:
        _PROGRESS[0] = None

def _link_budget_tex(lk):
    b = lk.get('budget'); budget = 1000000
    if b == 'Unlimited': budget = 0
    elif b and b.isdigit(): budget = int(b)
    t = lk.get('tex'); tex = int(t) if (t and t.isdigit()) else 1024
    return budget, tex

def quick_update():
    """1-Klick: aktualisiert das mit DIESER Datei verknuepfte Projekt (ohne Dialog)."""
    lk = link_get()
    if not lk:
        rs.MessageBox('This file is not linked to any project.\nOpen the Publish panel once and create a new project.', 0, 'Publish'); return
    projects = fetch_projects(); ver = 1; existing = {}
    for p in projects:
        if p['id'] == lk['id']:
            ver = int(p.get('version', 1)) + 1
            if isinstance(p.get('settings'), dict): existing = p['settings']
            break
    budget, tex = _link_budget_tex(lk)
    Rhino.RhinoApp.WriteLine('[publish] 1-click update: "%s" -> v%d' % (lk['name'], ver))
    ok, msg, mb, info = export_and_upload(lk['name'], lk['id'], ver, budget, tex, True, True, existing, None)
    if ok:
        link_set(lk['id'], lk['name'], budget, tex, lk.get('layers', ''))
        if rs.MessageBox('Updated: "%s" v%d (%.1f MB)\n\n%s\n\nOpen in browser?' % (lk['name'], ver, mb, msg), 4, 'Publish') == 6: open_url(msg)
    else:
        rs.MessageBox('Error: ' + msg, 0, 'Publish')

def do_publish():
    doc = sc.doc
    OPT['layers'] = None; OPT['selected_only'] = False

    # Polygon budget
    pb = rs.ListBox(['250000','500000','1000000','2000000','Unlimited'], 'Polygon budget (smaller = lighter)', 'Publish: Polygons', '1000000')
    if pb is None: return
    OPT['poly_budget'] = 0 if pb=='Unlimited' else int(pb)

    # Texture size
    tm = rs.ListBox(['512','1024','2048'], 'Max. texture size (px)', 'Publish: Textures', '1024')
    if tm is None: return
    OPT['max_tex'] = int(tm)

    # Project name (new or update existing)
    projects = fetch_projects()
    names = [p['name'] for p in projects]
    NEW = '[ New project ... ]'
    pick = rs.ListBox([NEW] + names, 'Project: create new or update', 'Publish: Target')
    if pick is None: return
    settings = {}
    if pick == NEW:
        name = rs.GetString('New project name')
        if not name: return
        name = name.strip(); pid = str(uuid.uuid4()); version = 1
    else:
        p = [x for x in projects if x['name']==pick][0]
        name = pick; pid = p['id']; version = int(p.get('version',1))+1
        if isinstance(p.get('settings'), dict): settings = dict(p['settings'])   # keep daylight settings

    cam = capture_camera()
    if cam: settings['start_camera'] = cam

    log('--- Collecting geometry & textures ---')
    raw=[]; (stats, tex_cache) = collect(raw)
    if not raw: rs.MessageBox('No visible geometry found.',0,'Publish'); return
    has_scan = stats['scan']>0
    log('Meshes %d | scan %d | glass %d | tex %d | blocks %d | hidden %d' %
        (stats['meshes'],stats['scan'],stats['glass'],stats['tex'],stats['blocks'],stats['hidden']))

    renderables = merge_and_extract(raw)
    if not renderables: rs.MessageBox('No geometry.',0,'Publish'); return
    log('Building GLB ...'); glb=build_glb(renderables, tex_cache)
    gz=gzip_bytes(glb); mb=len(gz)/1048576.0
    log('Upload size %.1f MB' % mb)
    if mb > 50:
        rs.MessageBox('File is %.1f MB > 50 MB (Supabase Free will reject).\nChoose a smaller polygon budget / texture, or turn textures off.' % mb,0,'Too large'); return

    path='projects/%s/model.glb.gz' % pid
    log('Uploading ...'); err=storage_upload(path, gz, 'application/gzip')
    if err: rs.MessageBox('Upload failed (%.1f MB):\n%s' % (mb, err),0,'Error'); return

    row={'id':pid,'name':name,'type':'rhino','file_path':path,
         'file_name':os.path.basename(doc.Path or 'rhino.3dm'),'has_2d_scan':has_scan,'version':version,'settings':settings}
    if not rest_json('/projects?on_conflict=id','POST',row):
        rs.MessageBox('Model is in storage, but writing the project row failed.',0,'Partial'); return

    url=VIEWER_BASE+'?p='+pid
    log('DONE -> '+url)
    link_set(pid, name, OPT['poly_budget'], OPT['max_tex'], '')
    if rs.MessageBox('Published (%.1f MB)!\n\n%s\n\nOpen in browser?' % (mb, url), 4, 'Publish') == 6: open_url(url)
    rs.ClipboardText(url)

def do_manage():
    while True:
        projects = fetch_projects()
        if not projects:
            rs.MessageBox('No projects online yet.',0,'Projects'); return
        labels = ['%s  (v%d%s)' % (p['name'], p.get('version',1), ', Scan' if p.get('has_2d_scan') else '') for p in projects]
        sel = rs.ListBox(labels, 'Choose a project', 'Projects online')
        if sel is None: return
        p = projects[labels.index(sel)]
        action = rs.ListBox(['Open in browser','Copy link','Rename','Delete','Back'], p['name'], 'Action')
        if action is None or action == 'Back': continue
        url = VIEWER_BASE+'?p='+p['id']
        if action == 'Open in browser':
            open_url(url)
        elif action == 'Copy link':
            rs.ClipboardText(url); rs.MessageBox('Link copied:\n'+url,0,'Link')
        elif action == 'Rename':
            nn = rs.GetString('New name', p['name'])
            if nn and nn.strip():
                if rest_json('/projects?id=eq.'+p['id'],'PATCH',{'name':nn.strip()}): log('Renamed -> '+nn)
        elif action == 'Delete':
            if rs.MessageBox('Really delete "%s"? (annotations stay in the DB, the model is removed)' % p['name'], 4, 'Delete') == 6:
                storage_delete(p.get('file_path',''))
                if rest_delete('/projects?id=eq.'+p['id']): log('Deleted: '+p['name'])

BUDGETS = ['250000', '500000', '1000000', '2000000', 'Unlimited']
TEXSIZES = ['512', '1024', '2048']

def show_panel():
    import Eto.Forms as F
    import Eto.Drawing as D
    import Rhino.UI

    def L(s, bold=False, dim=False):
        x = F.Label(); x.Text = s
        try:
            if bold: x.Font = D.Font(D.FontFamilies.Sans, 8, D.FontStyle.Bold)
            if dim: x.TextColor = D.Colors.Gray
        except: pass
        return x

    link0 = link_get()
    scan_n = doc_scan_info()
    S = {'projects': []}

    dlg = F.Dialog(); dlg.Title = 'Dreihoch Publisher  v%s' % PLUGIN_VERSION
    dlg.Padding = D.Padding(12); dlg.Resizable = True; dlg.MinimumSize = D.Size(430, 600)

    # ---- THIS FILE ----
    linked_lbl = L(''); scan_lbl = L('', dim=True)
    btn_unlink = F.Button(); btn_unlink.Text = 'Unlink'
    def upd_file_box():
        lk = link_get()
        if lk:
            ver = '?'
            for p in S['projects']:
                if p['id'] == lk['id']: ver = str(p.get('version', 1)); break
            linked_lbl.Text = u'●  Linked to  "%s"  (v%s)' % (lk['name'], ver)
            btn_unlink.Visible = True
        else:
            linked_lbl.Text = u'○  This file is not linked yet'
            btn_unlink.Visible = False
        scan_lbl.Text = (u'3D scan in file:  detected  (%d tiles)' % scan_n) if scan_n > 0 else u'3D scan in file:  none found'
    def on_unlink(s, e): link_clear(); upd_file_box(); status_lbl.Text = 'Link removed.'
    btn_unlink.Click += on_unlink

    # ---- OPTIONS ----
    budget_dd = F.DropDown()
    for it in BUDGETS: budget_dd.Items.Add(it)
    budget_dd.SelectedIndex = 2
    if link0 and link0.get('budget') in BUDGETS: budget_dd.SelectedIndex = BUDGETS.index(link0['budget'])
    tex_dd = F.DropDown()
    for it in TEXSIZES: tex_dd.Items.Add(it)
    tex_dd.SelectedIndex = 1
    if link0 and link0.get('tex') in TEXSIZES: tex_dd.SelectedIndex = TEXSIZES.index(link0['tex'])
    cb_tex = F.CheckBox(); cb_tex.Text = 'Upload textures'; cb_tex.Checked = True
    cb_mat = F.CheckBox(); cb_mat.Text = 'Upload material colors'; cb_mat.Checked = True

    # ---- STATUS / PROGRESS ----
    progress = F.ProgressBar(); progress.Indeterminate = True; progress.Visible = False
    status_lbl = L('Ready.')
    def status(m):
        status_lbl.Text = m
        try: F.Application.Instance.RunIteration()
        except: pass

    projlist = F.ListBox(); projlist.Height = 150

    def cur_budget():
        v = BUDGETS[budget_dd.SelectedIndex]; return 0 if v == 'Unlimited' else int(v)
    def cur_tex(): return int(TEXSIZES[tex_dd.SelectedIndex])

    def refresh_list():
        S['projects'] = fetch_projects()
        projlist.Items.Clear()
        for p in S['projects']:
            projlist.Items.Add(u'%s      v%s%s' % (p['name'], p.get('version', 1), '    [Scan]' if p.get('has_2d_scan') else ''))
        upd_file_box()
    def existing_settings_for(pid):
        for p in S['projects']:
            if p['id'] == pid and isinstance(p.get('settings'), dict): return p['settings']
        return {}

    def set_busy(b):
        progress.Visible = b
        for btn in [btn_update, btn_new, btn_open, btn_del, btn_link, btn_ref, btn_admin]: btn.Enabled = not b
        try: F.Application.Instance.RunIteration()
        except: pass

    def publish_core(name, pid, version):
        set_busy(True); status('Starting ...')
        try:
            ok, msg, mb, info = export_and_upload(name, pid, version, cur_budget(), cur_tex(), cb_tex.Checked, cb_mat.Checked, existing_settings_for(pid), status)
        finally:
            set_busy(False)
        if ok:
            link_set(pid, name, BUDGETS[budget_dd.SelectedIndex], TEXSIZES[tex_dd.SelectedIndex], '')
            refresh_list(); status_lbl.Text = u'✓ Done - "%s" v%d  (%.1f MB)' % (name, version, mb)
            if rs.MessageBox('Published (%.1f MB)!\n\n%s\n\nOpen in browser?' % (mb, msg), 4, 'Publish') == 6: open_url(msg)
            rs.ClipboardText(msg)
        else:
            status_lbl.Text = 'Error: ' + msg
            rs.MessageBox(msg, 0, 'Publish')

    def on_update(s, e):
        lk = link_get()
        if not lk:
            rs.MessageBox('Not linked yet.\nUse "New project" - or select a project below and click "Link to file".', 0, 'Publish'); return
        ver = 1
        for p in S['projects']:
            if p['id'] == lk['id']: ver = int(p.get('version', 1)) + 1; break
        publish_core(lk['name'], lk['id'], ver)
    def on_new(s, e):
        name = rs.GetString('New project name')
        if not name: return
        publish_core(name.strip(), str(uuid.uuid4()), 1)
    def sel_proj():
        i = projlist.SelectedIndex
        return S['projects'][i] if (i is not None and 0 <= i < len(S['projects'])) else None
    def on_open(s, e):
        p = sel_proj()
        if p: open_url(VIEWER_BASE + '?p=' + p['id'])
    def on_delete(s, e):
        p = sel_proj()
        if not p: return
        if rs.MessageBox('Really delete "%s"?' % p['name'], 4, 'Delete') == 6:
            storage_delete(p.get('file_path', '')); rest_delete('/projects?id=eq.' + p['id']); refresh_list(); status_lbl.Text = 'Deleted.'
    def on_link(s, e):
        p = sel_proj()
        if p:
            link_set(p['id'], p['name'], BUDGETS[budget_dd.SelectedIndex], TEXSIZES[tex_dd.SelectedIndex], '')
            upd_file_box(); status_lbl.Text = u'Linked to "%s"' % p['name']
    def on_refresh(s, e): refresh_list(); status_lbl.Text = 'List refreshed.'
    def on_admin(s, e): open_url(ADMIN_URL)

    btn_update = F.Button(); btn_update.Text = u'↻   Update  (1 click)'; btn_update.Click += on_update
    btn_new = F.Button(); btn_new.Text = u'+   New project'; btn_new.Click += on_new
    btn_open = F.Button(); btn_open.Text = 'Open'; btn_open.Click += on_open
    btn_del = F.Button(); btn_del.Text = 'Delete'; btn_del.Click += on_delete
    btn_link = F.Button(); btn_link.Text = 'Link to file'; btn_link.Click += on_link
    btn_ref = F.Button(); btn_ref.Text = 'Refresh'; btn_ref.Click += on_refresh
    btn_admin = F.Button(); btn_admin.Text = 'Admin page'; btn_admin.Click += on_admin
    btn_close = F.Button(); btn_close.Text = 'Close'; btn_close.Click += (lambda s, e: dlg.Close())

    refresh_list()

    def gbox(title, inner):
        gb = F.GroupBox(); gb.Text = title; gb.Padding = D.Padding(8); gb.Content = inner; return gb

    hdr = F.DynamicLayout(); hdr.AddRow(L('Dreihoch Metaverse', bold=True), None, L('Publisher v%s' % PLUGIN_VERSION, dim=True))

    g1 = F.DynamicLayout(); g1.DefaultSpacing = D.Size(6, 4)
    g1.AddRow(linked_lbl, None, btn_unlink)
    g1.AddRow(scan_lbl)

    g2 = F.DynamicLayout(); g2.DefaultSpacing = D.Size(8, 6)
    g2.AddRow(L('Polygon budget'), budget_dd)
    g2.AddRow(L('Texture size (px)'), tex_dd)
    g2.AddRow(cb_tex)
    g2.AddRow(cb_mat)

    g3 = F.DynamicLayout(); g3.DefaultSpacing = D.Size(6, 6)
    g3.AddRow(projlist)
    rb = F.DynamicLayout(); rb.DefaultSpacing = D.Size(6, 6); rb.AddRow(btn_open, btn_link, btn_del, btn_ref)
    g3.AddRow(rb)

    main = F.DynamicLayout(); main.DefaultSpacing = D.Size(8, 8)
    main.AddRow(hdr)
    main.AddRow(gbox('THIS FILE', g1))
    main.AddRow(gbox('EXPORT OPTIONS', g2))
    main.AddRow(btn_update)
    main.AddRow(btn_new)
    main.AddRow(progress)
    main.AddRow(status_lbl)
    main.AddRow(gbox('PROJECTS ONLINE', g3))
    ft = F.DynamicLayout(); ft.DefaultSpacing = D.Size(6, 6); ft.AddRow(btn_admin, None, btn_close)
    main.AddRow(ft)
    dlg.Content = main

    if globals().get('PR85_NOSHOW'): return dlg   # Test-Hook: nur konstruieren
    try: dlg.ShowModal(Rhino.UI.RhinoEtoApp.MainWindow)
    except: dlg.ShowModal()

def menu_main():
    choice = rs.ListBox(['Modell veroeffentlichen', 'Projekte verwalten', 'Abbrechen'],
                        'Prinzenstrasse-Rundgang', 'Publish & Manage')
    if not choice or choice == 'Abbrechen': return
    if choice == 'Modell veroeffentlichen': do_publish()
    else: do_manage()

def register_aliases():
    """Befehle Publish / PublishUpload / PublishAdmin registrieren (fuer Toolbar-Buttons).
    Selbst-lokalisierend ueber __file__; macht nichts, falls Pfad unbekannt."""
    try: p = __file__
    except: return
    if not p or not p.lower().endswith('.py'): return
    try:
        base = os.path.dirname(p)
        up = os.path.join(base, 'pr85_upload.py')
        al = Rhino.ApplicationSettings.CommandAliasList
        def setalias(name, macro):
            try:
                if al.IsAlias(name): al.SetMacro(name, macro)
                else: al.Add(name, macro)
            except: pass
        setalias('Publish', '_-RunPythonScript "%s"' % p)
        setalias('PublishUpload', '_-RunPythonScript "%s"' % up)
    except Exception as e: log('Alias-Registrierung: %s' % e)

def main():
    register_aliases()
    # Modus via sticky (Toolbar-Button "1-Klick" setzt 'upload', danach Reset)
    try: mode = sc.sticky.get('pr85_mode', 'panel')
    except: mode = 'panel'
    try: sc.sticky['pr85_mode'] = 'panel'
    except: pass
    try:
        if mode == 'upload': quick_update()
        else: show_panel()
    except Exception as e:
        import traceback; log('Panel-Fehler -> Menue: %s' % e); log(traceback.format_exc()[-300:])
        menu_main()

main()
