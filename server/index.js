import { createDb } from './db.js';
import { createApp, APP_NAME } from './app.js';

const port = Number(process.env.PORT) || 3000;
const db = createDb();

try {
  const app = await createApp({ db });
  app.server.listen(port, '0.0.0.0', () => {
    console.log(`${APP_NAME} läuft auf Port ${port} (Datenbank: ${db.kind})`);
  });
  const stop = async () => {
    console.log('Fahre herunter …');
    await app.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (e) {
  console.error('Start fehlgeschlagen:', e.message);
  process.exit(1);
}
