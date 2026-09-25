// Xử lý ảnh: tải ảnh, dò mép giấy, nắn phối cảnh, xoay, bộ lọc làm nét.

const MAX_SOURCE = 2600; // cạnh dài tối đa của ảnh gốc giữ trong bộ nhớ
const MAX_OUTPUT = 2200; // cạnh dài tối đa của trang sau khi cắt

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function scaleCanvas(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (s === 1) return src;
  const c = makeCanvas(src.width * s, src.height * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/** Đọc file ảnh (kể cả ảnh xoay EXIF) thành canvas đã thu nhỏ. */
export async function imageFileToCanvas(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Không đọc được ảnh: ' + file.name));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width || bmp.naturalWidth;
  const h = bmp.height || bmp.naturalHeight;
  const s = Math.min(1, MAX_SOURCE / Math.max(w, h));
  const c = makeCanvas(w * s, h * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

export const FULL_CORNERS = () => [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/**
 * Dò 4 góc tờ giấy. Giả định tờ giấy sáng hơn nền: nhị phân hóa bằng Otsu,
 * lấy vùng sáng liên thông lớn nhất, rồi lấy 4 điểm cực trị làm góc.
 * Trả về tọa độ chuẩn hóa 0..1 theo thứ tự TL, TR, BR, BL.
 */
export function detectCorners(canvas) {
  const small = scaleCanvas(canvas, 260);
  const w = small.width;
  const h = small.height;
  const data = small.getContext('2d').getImageData(0, 0, w, h).data;
  const n = w * h;

  // Thang xám + làm mờ 3x3
  const g0 = new Float32Array(n);
  for (let i = 0; i < n; i++) g0[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const g = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += g0[yy * w + xx];
          c++;
        }
      }
      g[y * w + x] = s / c;
    }
  }

  // Ngưỡng Otsu
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) hist[g[i] | 0]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = t;
    }
  }

  // Vùng sáng liên thông lớn nhất (ưu tiên vùng chứa tâm ảnh)
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = g[i] > thr ? 1 : 0;
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  let bestLabel = 0;
  let bestScore = 0;
  let cur = 0;
  const center = ((h / 2) | 0) * w + ((w / 2) | 0);
  for (let i = 0; i < n; i++) {
    if (!mask[i] || label[i]) continue;
    cur++;
    let sp = 0;
    let size = 0;
    let hasCenter = false;
    stack[sp++] = i;
    label[i] = cur;
    while (sp) {
      const p = stack[--sp];
      size++;
      if (p === center) hasCenter = true;
      const px = p % w;
      const nb = [p - w, p + w, px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1];
      for (const q of nb) {
        if (q >= 0 && q < n && mask[q] && !label[q]) {
          label[q] = cur;
          stack[sp++] = q;
        }
      }
    }
    const score = size * (hasCenter ? 1.5 : 1);
    if (score > bestScore) {
      bestScore = score;
      bestLabel = cur;
    }
  }

  let tl, tr, br, bl;
  let mTL = Infinity, mBR = -Infinity, mTR = -Infinity, mBL = Infinity;
  let area = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== bestLabel) continue;
      area++;
      const s = x + y;
      const d = x - y;
      if (s < mTL) { mTL = s; tl = { x, y }; }
      if (s > mBR) { mBR = s; br = { x, y }; }
      if (d > mTR) { mTR = d; tr = { x, y }; }
      if (d < mBL) { mBL = d; bl = { x, y }; }
    }
  }
  const ratio = area / n;
  if (!tl || ratio < 0.12 || ratio > 0.985) return null;
  const quad = [tl, tr, br, bl].map((p) => ({ x: p.x / (w - 1), y: p.y / (h - 1) }));
  const qa = polygonArea(quad);
  if (qa < 0.1 || !isConvex(quad)) return null;
  return quad;
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function isConvex(pts) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = pts[i], b = pts[(i + 1) % 4], c = pts[(i + 2) % 4];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) continue;
    const s = Math.sign(z);
    if (!sign) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function isFull(c) {
  const f = FULL_CORNERS();
  return c.every((p, i) => Math.abs(p.x - f[i].x) < 1e-3 && Math.abs(p.y - f[i].y) < 1e-3);
}

/** Giải hệ 8 ẩn: ma trận đồng nhất ánh xạ (u,v) của ảnh đích -> (x,y) của ảnh nguồn. */
function homography(dst, src) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dst[i];
    const { x, y } = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]);
    b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]);
    b.push(y);
  }
  for (let c = 0; c < 8; c++) {
    let piv = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [...h, 1];
}

/** Cắt + nắn phẳng vùng tứ giác (tọa độ chuẩn hóa) thành hình chữ nhật. */
export function warpQuad(src, corners) {
  if (isFull(corners)) return scaleCanvas(src, MAX_OUTPUT);
  const W = src.width;
  const H = src.height;
  const P = corners.map((p) => ({ x: p.x * (W - 1), y: p.y * (H - 1) }));
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let ow = Math.max(d(P[0], P[1]), d(P[3], P[2]));
  let oh = Math.max(d(P[0], P[3]), d(P[1], P[2]));
  const s = Math.min(1, MAX_OUTPUT / Math.max(ow, oh));
  ow = Math.max(2, Math.round(ow * s));
  oh = Math.max(2, Math.round(oh * s));
  const Hm = homography(
    [{ x: 0, y: 0 }, { x: ow - 1, y: 0 }, { x: ow - 1, y: oh - 1 }, { x: 0, y: oh - 1 }],
    P,
  );
  const sd = src.getContext('2d').getImageData(0, 0, W, H).data;
  const out = makeCanvas(ow, oh);
  const octx = out.getContext('2d');
  const od = octx.createImageData(ow, oh);
  const o = od.data;
  let k = 0;
  for (let v = 0; v < oh; v++) {
    for (let u = 0; u < ow; u++) {
      const den = Hm[6] * u + Hm[7] * v + 1;
      let x = (Hm[0] * u + Hm[1] * v + Hm[2]) / den;
      let y = (Hm[3] * u + Hm[4] * v + Hm[5]) / den;
      if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
      if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
      const x0 = x | 0, y0 = y | 0;
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * W + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + W * 4;
      const i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
        o[k + ch] = top + (bot - top) * fy;
      }
      o[k + 3] = 255;
      k += 4;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

export function rotateCanvas(src, deg) {
  const r = ((deg % 360) + 360) % 360;
  if (!r) return src;
  const swap = r === 90 || r === 270;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Bộ lọc: none | enhance (làm nét, cân bằng sáng) | gray | bw (đen trắng thích nghi). */
export function applyFilter(src, filter) {
  if (!filter || filter === 'none') return src;
  const w = src.width;
  const h = src.height;
  const out = makeCanvas(w, h);
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;

  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];

  if (filter === 'gray' || filter === 'enhance') {
    // Kéo giãn mức sáng theo phân vị 1% – 99%
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[lum[i] | 0]++;
    let lo = 0, hi = 255, acc = 0;
    for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc > n * 0.01) { lo = t; break; } }
    acc = 0;
    for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc > n * 0.01) { hi = t; break; } }
    const range = Math.max(30, hi - lo);
    const lut = new Uint8ClampedArray(256);
    for (let t = 0; t < 256; t++) lut[t] = ((t - lo) * 255) / range;

    if (filter === 'gray') {
      for (let i = 0; i < n; i++) {
        const v = lut[lum[i] | 0];
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      }
    } else {
      for (let i = 0; i < n * 4; i += 4) {
        d[i] = lut[d[i]];
        d[i + 1] = lut[d[i + 1]];
        d[i + 2] = lut[d[i + 2]];
      }
      // Làm nét (unsharp 3x3)
      const copy = new Uint8ClampedArray(d);
      const a = 0.55;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const lap = 4 * copy[i + c] - copy[i - 4 + c] - copy[i + 4 + c] - copy[i - w * 4 + c] - copy[i + w * 4 + c];
            d[i + c] = copy[i + c] + a * lap;
          }
        }
      }
    }
  } else if (filter === 'bw') {
    // Ngưỡng thích nghi Bradley dùng ảnh tích phân
    const integral = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += lum[y * w + x];
        integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + row;
      }
    }
    const half = Math.max(8, Math.round(Math.max(w, h) / 32));
    const t = 0.13;
    for (let y = 0; y < h; y++) {
      const y1 = Math.max(0, y - half), y2 = Math.min(h - 1, y + half);
      for (let x = 0; x < w; x++) {
        const x1 = Math.max(0, x - half), x2 = Math.min(w - 1, x + half);
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const s =
          integral[(y2 + 1) * (w + 1) + (x2 + 1)] -
          integral[y1 * (w + 1) + (x2 + 1)] -
          integral[(y2 + 1) * (w + 1) + x1] +
          integral[y1 * (w + 1) + x1];
        const i = y * w + x;
        const v = lum[i] * count < s * (1 - t) ? 0 : 255;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/** Chạy toàn bộ pipeline cho một trang. */
export function processPage(page) {
  const cropped = warpQuad(page.source, page.corners);
  const rotated = rotateCanvas(cropped, page.rotation);
  return applyFilter(rotated, page.filter);
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
