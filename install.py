# -*- coding: utf-8 -*-
# ===========================================================================
#  Dreihoch Metaverse -- Installer  (run once)
#  Installs the Publisher into Rhino: copies the scripts into Rhino's scripts
#  folder and registers the commands  Publish  and  PublishUpload.
#  Works in Rhino 6, 7 and 8.   Run:  _RunPythonScript  ->  install.py
# ===========================================================================
import Rhino, System, os, shutil
import rhinoscriptsyntax as rs

FILES = ['rhino_publish.py', 'pr85_upload.py']

def scripts_folder():
    appdata = System.Environment.GetFolderPath(System.Environment.SpecialFolder.ApplicationData)
    ver = '%d.0' % Rhino.RhinoApp.ExeVersion
    p = os.path.join(appdata, 'McNeel', 'Rhinoceros', ver, 'scripts')
    try:
        if not os.path.isdir(p): os.makedirs(p)
    except: pass
    return p

def main():
    try: here = os.path.dirname(__file__)
    except: here = None
    if not here or not os.path.exists(os.path.join(here, 'rhino_publish.py')):
        rs.MessageBox('Could not locate the script files.\nPlease keep install.py next to rhino_publish.py and pr85_upload.py, then run it again.', 0, 'Dreihoch Installer'); return

    dest = scripts_folder()
    copied = []
    for f in FILES:
        src = os.path.join(here, f)
        if os.path.exists(src):
            try: shutil.copy2(src, os.path.join(dest, f)); copied.append(f)
            except Exception as e: Rhino.RhinoApp.WriteLine('[install] copy %s failed: %s' % (f, e))

    pub = os.path.join(dest, 'rhino_publish.py')
    upl = os.path.join(dest, 'pr85_upload.py')
    al = Rhino.ApplicationSettings.CommandAliasList
    def set_alias(name, macro):
        try:
            if al.IsAlias(name): al.SetMacro(name, macro)
            else: al.Add(name, macro)
            return True
        except Exception as e:
            Rhino.RhinoApp.WriteLine('[install] alias %s failed: %s' % (name, e)); return False
    a1 = set_alias('Publish', '_-RunPythonScript "%s"' % pub)
    a2 = set_alias('PublishUpload', '_-RunPythonScript "%s"' % upl)

    Rhino.RhinoApp.WriteLine('[install] copied %d files to %s' % (len(copied), dest))
    msg = ('Installed!\n\n'
           'Commands now available:\n'
           '   Publish          - open the Publisher panel\n'
           '   PublishUpload    - 1-click update of the linked file\n\n'
           'Just type the command, or drag it onto a toolbar to make a button.\n'
           '(Right-click a toolbar -> New Button -> command:  Publish)')
    rs.MessageBox(msg, 0, 'Dreihoch Metaverse - installed')

main()
