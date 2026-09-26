// Tạo PDF: ảnh trang + lớp chữ ẩn (tìm kiếm/copy được), số trang, dấu chìm, mật khẩu.

import { LIBS, loadScript } from './converters.js';
import { blobToCanvas, drawWatermark, scaleCanvas } from './imaging.js';

const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
let fontB64 = null;

async function loadFont() {
  if (fontB64) return fontB64;
  const res = await fetch(LIBS.font);
  if (!res.ok) throw new Error('Không tải được font tiếng Việt');
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  fontB64 = btoa(bin);
  return fontB64;
}

/**
 * pages: [{ blob, filter }] – ảnh đã xử lý
 * ocr:   mảng song song { width, height, words } (hoặc null) để tạo lớp chữ
 * opts:  { size, quality, pageNumbers, watermark, password, meta }
 */
export async function buildPdf(pages, ocr, opts, onProgress) {
  await loadScript(LIBS.jspdf);
  const { jsPDF } = window.jspdf;
  const needFont = opts.pageNumbers || (ocr && ocr.some(Boolean));
  const font = needFont ? await loadFont().catch(() => null) : null;
  const maxSide = opts.quality >= 0.9 ? 2400 : opts.quality <= 0.6 ? 1400 : 1900;

  let doc = null;
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(i / pages.length, `Đang dựng trang ${i + 1}/${pages.length}`);
    let img = scaleCanvas(await blobToCanvas(pages[i].blob), maxSide);
    if (opts.watermark) img = drawWatermark(img, opts.watermark);
    let pw, ph;
    if (opts.size === 'fit') {
      pw = (img.width * 72) / 150;
      ph = (img.height * 72) / 150;
    } else {
      [pw, ph] = SIZES[opts.size] || SIZES.a4;
      if (img.width > img.height) [pw, ph] = [ph, pw];
    }
    const orientation = pw > ph ? 'l' : 'p';
    if (!doc) {
      const init = { unit: 'pt', format: [pw, ph], orientation, compress: true };
      if (opts.password) {
        init.encryption = {
          userPassword: opts.password,
          ownerPassword: opts.password + '#owner',
          userPermissions: ['print', 'copy'],
        };
      }
      doc = new jsPDF(init);
      if (font) {
        doc.addFileToVFS('Roboto.ttf', font);
        doc.addFont('Roboto.ttf', 'Roboto', 'normal');
      }
    } else {
      doc.addPage([pw, ph], orientation);
    }
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s;
    const h = img.height * s;
    const ox = (pw - w) / 2;
    const oy = (ph - h) / 2;
    const gray = pages[i].filter === 'bw' || pages[i].filter === 'gray';
    doc.addImage(img.toDataURL('image/jpeg', gray ? Math.min(opts.quality, 0.75) : opts.quality), 'JPEG', ox, oy, w, h, undefined, 'FAST');

    // Lớp chữ ẩn: đặt từng từ đúng vị trí trên ảnh
    const layer = ocr?.[i];
    if (font && layer?.words?.length) {
      doc.setFont('Roboto', 'normal');
      const k = w / layer.width;
      for (const wd of layer.words) {
        const bw = (wd.x1 - wd.x0) * k;
        const bh = (wd.y1 - wd.y0) * k;
        if (bw <= 0 || bh <= 0) continue;
        let size = bh * 1.1;
        doc.setFontSize(size);
        const natural = doc.getTextWidth(wd.text);
        if (natural > 0) size = Math.max(2, Math.min(size * 1.6, (size * bw) / natural));
        doc.setFontSize(size);
        doc.text(wd.text, ox + wd.x0 * k, oy + wd.y1 * k - bh * 0.12, { renderingMode: 'invisible' });
      }
    }
    if (font && opts.pageNumbers) {
      doc.setFont('Roboto', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(110);
      doc.text(`Trang ${i + 1}/${pages.length}`, pw / 2, ph - 12, { align: 'center' });
      doc.setTextColor(0);
    }
    img = null;
    await new Promise((r) => setTimeout(r, 0));
  }
  const m = opts.meta || {};
  doc.setProperties({
    title: m.title || m.docType || 'Tài liệu',
    subject: (m.summary || '').slice(0, 500),
    keywords: [m.docType, m.entity, ...(m.tags || [])].filter(Boolean).join(', '),
    creator: 'PDF Scanner AI',
  });
  onProgress?.(1, 'Đang nén PDF…');
  return doc.output('blob');
}
