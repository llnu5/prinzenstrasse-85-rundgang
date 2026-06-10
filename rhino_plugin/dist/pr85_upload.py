# -*- coding: utf-8 -*-
# 1-Klick-Upload-Launcher: aktualisiert das mit der offenen .3dm verknuepfte Projekt
# (ohne Dialog). Fuer einen Toolbar-Button. Liegt neben rhino_publish.py.
import scriptcontext as sc, os
sc.sticky['pr85_mode'] = 'upload'
try:
    base = os.path.dirname(__file__)
except:
    base = r'G:\Meine Ablage\DESIGN AND SET\Dopamine\3D Scan\dollhouse-viewer'
execfile(os.path.join(base, 'rhino_publish.py'))
