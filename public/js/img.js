// Bilder auf dem Handy verkleinern, bevor sie hochgeladen werden
async function decode(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Liefert { blob, dataUrl, width, height }
export async function resizeImage(file, { maxSide = 1600, quality = 0.82, maxBytes = Infinity } = {}) {
  const src = await decode(file);
  const w0 = src.width, h0 = src.height;
  let scale = Math.min(1, maxSide / Math.max(w0, h0));
  let q = quality;
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(w0 * scale)), h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && (blob.size <= maxBytes || attempt === 5)) {
      src.close?.();
      return { blob, dataUrl: await blobToDataUrl(blob), width: w, height: h };
    }
    if (q > 0.6) q -= 0.1; else scale *= 0.82;
  }
  throw new Error('Bild konnte nicht verkleinert werden');
}

export function pickFile(accept, { capture } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(input.files?.[0] || null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}
