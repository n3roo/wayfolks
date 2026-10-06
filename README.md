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

## Fotos und Videos (Backblaze B2, kostenlos bis 10 GB)

1. Konto auf backblaze.com anlegen, unter **Buckets → Create a Bucket** einen Bucket erstellen: **Private**, Verschlüsselung und Object Lock aus.
2. Im Bucket **CORS Rules**: Herkunft `https://<dein-dienst>.onrender.com`, S3-Vorgänge `PUT`, `GET`, `HEAD`, Header `*`.
3. **App Keys → Add a New Application Key**: nur dieser Bucket, *Read and Write*. Der Schlüssel wird nur einmal angezeigt.
4. In Render diese Variablen eintragen:
   - `S3_ENDPOINT` = z. B. `s3.eu-central-003.backblazeb2.com`
   - `S3_BUCKET` = Bucket-Name
   - `S3_KEY_ID` = keyID
   - `S3_APP_KEY` = applicationKey
   - optional `S3_REGION` (wird bei Backblaze automatisch aus dem Endpoint erkannt)
   - optional `MEDIA_PUBLIC_URL`, falls der Bucket öffentlich ist (sonst werden signierte Links verwendet)

Prüfen: `https://<dein-dienst>.onrender.com/api/health?storage=1` zeigt, ob Zugangsdaten und CORS stimmen. Bietet das Backblaze-Formular die S3-Vorgänge nicht an und die Prüfung meldet „CORS fehlt“, kann die Regel mit dem B2-Kommandozeilenwerkzeug (`b2 bucket update --cors-rules`) mit den Vorgängen `s3_put`, `s3_get`, `s3_head` gesetzt werden.

Funktioniert auch mit Cloudflare R2 (Endpoint `<account>.r2.cloudflarestorage.com`, Region `auto`, öffentliche URL in `MEDIA_PUBLIC_URL`).

Fotos werden auf dem Handy auf maximal 2048 px verkleinert, Videos dürfen höchstens 100 MB groß sein. Uploads bleiben auf dem Gerät gespeichert und werden nachgeholt, sobald wieder Netz da ist.

## Lokal

    npm install
    npm start        # lokale SQLite-Datei, http://localhost:3000
    npm test
    MEDIA_DEV=1 npm start   # lokaler Test-Speicher für Fotos im Arbeitsspeicher
