// Chuyển các loại file đầu vào (PDF, Word, Excel, văn bản) thành danh sách trang ảnh.
// Thư viện được tải khi cần để app mở nhanh.

import { makeCanvas } from './imaging.js';

const CDN = 'https://cdn.jsdelivr.net/npm/';
export const LIBS = {
  jspdf: CDN + 'jspdf@2.5.1/dist/jspdf.umd.min.js',
  pdfjs: CDN + 'pdfjs-dist@3.11.174/build/pdf.min.js',
  pdfWorker: CDN + 'pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  mammoth: CDN + 'mammoth@1.8.0/mammoth.browser.min.js',
  xlsx: CDN + 'xlsx@0.18.5/dist/xlsx.full.min.js',
  html2canvas: CDN + 'html2canvas@1.4.1/dist/html2canvas.min.js',
  tesseract: CDN + 'tesseract.js@5.1.1/dist/tesseract.min.js',
  anthropic: CDN + '@anthropic-ai/sdk/+esm',
};

const loaded = new Map();
export function loadScript(url) {
  if (!loaded.has(url)) {
    loaded.set(
      url,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => {
          loaded.delete(url);
          reject(new Error('Không tải được thư viện (kiểm tra kết nối mạng): ' + url));
        };
        document.head.appendChild(s);
      }),
    );
  }
  return loaded.get(url);
}

export function fileKind(file) {
  const n = file.name.toLowerCase();
  if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/.test(n)) return 'image';
  if (file.type === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (n.endsWith('.docx')) return 'word';
  if (n.endsWith('.doc')) return 'doc-legacy';
  if (/\.(xlsx|xls|csv|ods)$/.test(n)) return 'excel';
  if (n.endsWith('.txt') || file.type.startsWith('text/')) return 'text';
  return 'unknown';
}

/** PDF -> các trang ảnh (kèm lớp chữ gốc nếu PDF có chữ). */
export async function pdfToPages(file, onProgress) {
  await loadScript(LIBS.pdfjs);
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const total = Math.min(doc.numPages, 80);
  const pages = [];
  for (let i = 1; i <= total; i++) {
    onProgress?.(`Đang đọc PDF trang ${i}/${total}`);
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1800 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const c = makeCanvas(vp.width, vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    let text = '';
    try {
      const tc = await page.getTextContent();
      text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').trim();
    } catch {}
    pages.push({ canvas: c, text, digital: text.length > 20 });
  }
  return pages;
}

/** Word (.docx) -> HTML -> ảnh các trang A4. */
export async function wordToPages(file, onProgress) {
  onProgress?.('Đang đọc file Word…');
  await loadScript(LIBS.mammoth);
  const buf = await file.arrayBuffer();
  const [{ value: html }, { value: text }] = await Promise.all([
    window.mammoth.convertToHtml({ arrayBuffer: buf }),
    window.mammoth.extractRawText({ arrayBuffer: buf }),
  ]);
  const css = `
    body{font-family:"Times New Roman",Times,serif;font-size:14pt;line-height:1.5}
    table{border-collapse:collapse;width:100%} td,th{border:1px solid #999;padding:4px 6px;vertical-align:top}
    img{max-width:100%} h1{font-size:20pt} h2{font-size:17pt} p{margin:0 0 8px}`;
  const canvases = await htmlToPages(`<style>${css}</style>${html}`, onProgress);
  return canvases.map((c, i) => ({ canvas: c, text: i === 0 ? text : '', digital: true }));
}

/** Excel/CSV -> bảng HTML (mỗi sheet) -> ảnh các trang. */
export async function excelToPages(file, onProgress) {
  onProgress?.('Đang đọc file Excel…');
  await loadScript(LIBS.xlsx);
  const XLSX = window.XLSX;
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const out = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws['!ref']) continue;
    const table = XLSX.utils.sheet_to_html(ws, { header: '', footer: '' });
    const csv = XLSX.utils.sheet_to_csv(ws);
    const css = `
      body{font-family:Arial,Helvetica,sans-serif;font-size:11pt}
      h2{font-size:14pt;margin:0 0 10px}
      table{border-collapse:collapse} td,th{border:1px solid #9aa;padding:3px 6px;white-space:nowrap}
      tr:nth-child(even) td{background:#f4f7f7}`;
    const canvases = await htmlToPages(`<style>${css}</style><h2>Sheet: ${escapeHtml(name)}</h2>${table}`, onProgress, true);
    canvases.forEach((c, i) => out.push({ canvas: c, text: i === 0 ? `[Sheet ${name}]\n${csv}` : '', digital: true }));
  }
  return out;
}

export async function textToPages(file, onProgress) {
  const text = await file.text();
  const html = `<style>body{font-family:monospace;font-size:11pt;white-space:pre-wrap}</style>${escapeHtml(text)}`;
  const canvases = await htmlToPages(html, onProgress);
  return canvases.map((c, i) => ({ canvas: c, text: i === 0 ? text : '', digital: true }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Dựng HTML trong khung A4 ẩn, chụp bằng html2canvas rồi cắt thành các trang. */
async function htmlToPages(html, onProgress, allowWide = false) {
  await loadScript(LIBS.html2canvas);
  const A4W = 794; // 210mm @ 96dpi
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;background:#fff;color:#000;padding:56px;box-sizing:border-box;';
  host.style.width = A4W + 'px';
  const inner = document.createElement('div');
  inner.innerHTML = html.replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${css.replace(/body/g, '.docx-body')}</style>`);
  inner.className = 'docx-body';
  host.appendChild(inner);
  document.body.appendChild(host);
  try {
    if (allowWide && inner.scrollWidth + 112 > A4W) host.style.width = inner.scrollWidth + 112 + 'px';
    const width = host.offsetWidth;
    const pageH = Math.round(width * 1.4142);
    // Tránh cắt ngang dòng: tìm điểm ngắt ở ranh giới các khối con
    const hostTop = host.getBoundingClientRect().top;
    const bottoms = [];
    inner.querySelectorAll('p,li,tr,h1,h2,h3,h4,img,pre,div').forEach((el) => {
      const r = el.getBoundingClientRect();
      bottoms.push(r.bottom - hostTop);
    });
    bottoms.sort((a, b) => a - b);
    const total = host.scrollHeight;
    const breaks = [0];
    while (total - breaks[breaks.length - 1] > pageH) {
      const start = breaks[breaks.length - 1];
      const limit = start + pageH - 56;
      let cut = limit;
      for (const b of bottoms) if (b > start + pageH * 0.5 && b <= limit) cut = b;
      breaks.push(Math.round(cut));
    }
    onProgress?.('Đang dựng trang…');
    const scale = 2;
    const full = await window.html2canvas(host, { scale, backgroundColor: '#ffffff', logging: false, useCORS: true });
    const pages = [];
    for (let i = 0; i < breaks.length; i++) {
      const y0 = breaks[i];
      const y1 = i + 1 < breaks.length ? breaks[i + 1] : total;
      const c = makeCanvas(width * scale, pageH * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      const sh = Math.min((y1 - y0) * scale, full.height - y0 * scale);
      if (sh > 0) ctx.drawImage(full, 0, y0 * scale, full.width, sh, 0, i === 0 ? 0 : 56 * scale, full.width, sh);
      pages.push(c);
    }
    return pages;
  } finally {
    host.remove();
  }
}
