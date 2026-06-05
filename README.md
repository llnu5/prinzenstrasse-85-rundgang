# Prinzenstraße 85 – 3D Rundgang

Interaktiver 3D-Rundgang durch den Matterport-Scan, als statische Web-App (Three.js).
Texturen sind in `model.glb` (Draco-komprimiert) eingebettet.

## Bedienung
- **Fliegen (WASD):** Rechte Maustaste halten + Maus = umsehen · `W A S D` bewegen · `Q/E` hoch/runter · `Shift` schneller · Mausrad = Tempo.
- **Umkreisen:** Linke Maustaste drehen · rechte Maustaste verschieben · Mausrad zoomen.
- **Reset** oder Taste `R` setzt die Ansicht zurück.

## Dateien
- `index.html` – Oberfläche/UI
- `main.js` – Viewer-Logik (Three.js via CDN)
- `model.glb` – das 3D-Modell mit Texturen (~54 MB)

## Lokal testen
Muss über einen Webserver laufen (nicht per Doppelklick), z. B.:
```
python -m http.server 8777
```
Dann http://localhost:8777 öffnen.

## Hosting
Als statische Seite über GitHub Pages (Branch `main`, Ordner `/root`).
