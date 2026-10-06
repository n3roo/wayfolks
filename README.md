# Wayfolk

Roadtrips gemeinsam planen und unterwegs festhalten. Installierbare Web-App (PWA), Node.js + WebSocket, Daten in Turso.

## Auf Render veröffentlichen (kostenlos)

1. Auf render.com anmelden → **New → Web Service** → dieses GitHub-Repository wählen.
2. **Language: Docker**, Instance Type **Free**.
3. Unter **Environment Variables** eintragen:
   - `TURSO_DATABASE_URL` = `libsql://wayfolks-unknowngaming.aws-eu-north-1.turso.io`
   - `TURSO_AUTH_TOKEN` = (Token aus Turso, nur dort eintragen)
4. **Deploy**. Der erste Start dauert ca. 1–2 Minuten.
5. Prüfen: `https://<dein-dienst>.onrender.com/api/health` → `ok: true`.

Turso-Token erzeugen: Turso-Dashboard → Datenbank → *Generate Token* (oder `turso db tokens create wayfolks`).

Im kostenlosen Render-Tarif schläft der Dienst nach 15 Min. Inaktivität; der nächste Aufruf braucht dann bis zu eine Minute.

## Lokal

    npm install
    npm start        # lokale SQLite-Datei, http://localhost:3000
    npm test
