// Erzeugt die PNG-Icons aus public/icons/logo.svg
// Aufruf: NODE_PATH=/opt/npm-tools/node_modules node scripts/make-icons.mjs   (benötigt "sharp")
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const dir = path.resolve('public/icons');
const svg = fs.readFileSync(path.join(dir, 'logo.svg'));

async function png(name, size, buf = svg) {
  await sharp(buf, { density: 384 }).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(dir, name));
}
await png('icon-192.png', 192);
await png('icon-512.png', 512);
await png('apple-touch-icon.png', 180);
await png('favicon-48.png', 48);

// Maskable: Motiv verkleinert auf vollflächigem Hintergrund (Sicherheitszone)
const inner = await sharp(svg, { density: 384 }).resize(360, 360).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#16233F' } })
  .composite([{ input: inner, gravity: 'center' }])
  .png({ compressionLevel: 9 })
  .toFile(path.join(dir, 'icon-maskable-512.png'));
console.log('Icons erzeugt');
