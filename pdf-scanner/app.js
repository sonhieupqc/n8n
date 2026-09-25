import {
  FULL_CORNERS,
  applyFilter,
  detectCorners,
  imageFileToCanvas,
  makeCanvas,
  processPage,
  scaleCanvas,
} from './imaging.js';
import { LIBS, excelToPages, fileKind, loadScript, pdfToPages, textToPages, wordToPages } from './converters.js';
import { DOC_TYPES, claudeAnalyze, localAnalyze, ocrPages } from './ai.js';
import { db, driveSignIn, driveSignedIn, requestPersistentStorage, saveToDevice, uploadToDrive } from './storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ------------------------------------------------------------------ Trạng thái
const state = {
  pages: [], // { id, source, corners, rotation, filter, out, thumb, text, digital }
  analysis: null,
};

const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-5',
  clientId: '',
  folder: 'PDF Scanner',
  subfolder: true,
  ocrLang: 'vie+eng',
  filter: 'enhance',
  autoCrop: true,
};
let settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pdfscanner.settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function storeSettings() {
  try {
    localStorage.setItem('pdfscanner.settings', JSON.stringify(settings));
  } catch {}
}

// ------------------------------------------------------------------ Tiện ích UI
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function progress(el, frac, text) {
  el.hidden = false;
  el.querySelector('.bar').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  el.querySelector('.txt').textContent = text || '';
}

function setStep(n) {
  $$('.steps li').forEach((li) => li.classList.toggle('on', Number(li.dataset.step) <= n));
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function toIsoDate(d) {
  const m = String(d || '').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!m) return new Date().toISOString().slice(0, 10);
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ------------------------------------------------------------------ Tab
$$('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.tabbar button').forEach((x) => x.classList.toggle('active', x === b));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'library') renderLibrary();
    window.scrollTo(0, 0);
  }),
);

function updateNet() {
  $('#netStatus').textContent = navigator.onLine ? '● Online' : '○ Offline';
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);
updateNet();

// ------------------------------------------------------------------ Bước 1: nguồn đầu vào
$$('.src').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.src === 'livecam') return openCamera();
    const input = $('#in-' + b.dataset.src);
    input.value = '';
    input.click();
  }),
);
['camera', 'gallery', 'pdf', 'word', 'excel', 'any'].forEach((k) =>
  $('#in-' + k).addEventListener('change', (e) => importFiles([...e.target.files])),
);

// Kéo-thả file (máy tính) và dán ảnh từ clipboard
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) importFiles([...e.dataTransfer.files]);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) importFiles(files);
});

async function importFiles(files) {
  if (!files.length) return;
  const prog = $('#aiProgress');
  $('#aiCard').hidden = false;
  let added = 0;
  for (const [fi, file] of files.entries()) {
    const kind = fileKind(file);
    const say = (t) => progress(prog, fi / files.length, `${file.name}: ${t}`);
    try {
      say('đang xử lý…');
      if (kind === 'image') {
        await addPage(await imageFileToCanvas(file), { photo: true });
        added++;
      } else if (kind === 'pdf') {
        for (const p of await pdfToPages(file, say)) {
          await addPage(p.canvas, { text: p.text, digital: p.digital });
          added++;
        }
      } else if (kind === 'word') {
        for (const p of await wordToPages(file, say)) {
          await addPage(p.canvas, { text: p.text, digital: true });
          added++;
        }
      } else if (kind === 'excel') {
        for (const p of await excelToPages(file, say)) {
          await addPage(p.canvas, { text: p.text, digital: true });
          added++;
        }
      } else if (kind === 'text') {
        for (const p of await textToPages(file, say)) {
          await addPage(p.canvas, { text: p.text, digital: true });
          added++;
        }
      } else if (kind === 'doc-legacy') {
        toast('File .doc đời cũ chưa hỗ trợ – hãy mở bằng Word và lưu lại dạng .docx');
      } else {
        toast('Không hỗ trợ định dạng: ' + file.name);
      }
    } catch (err) {
      console.error(err);
      toast('Lỗi: ' + err.message, 5000);
    }
  }
  prog.hidden = true;
  if (added) toast(`Đã thêm ${added} trang`);
}

async function addPage(canvas, { photo = false, text = '', digital = false } = {}) {
  let corners = FULL_CORNERS();
  if (photo && settings.autoCrop) corners = detectCorners(canvas) || FULL_CORNERS();
  const page = {
    id: uid(),
    source: canvas,
    corners,
    rotation: 0,
    filter: photo ? settings.filter : 'none',
    text,
    digital,
    photo,
  };
  refreshPage(page);
  state.pages.push(page);
  state.analysis = null;
  renderPages();
  // Nhường luồng cho trình duyệt vẽ lại giữa các trang
  await new Promise((r) => setTimeout(r, 0));
}

function refreshPage(page) {
  page.out = processPage(page);
  page.thumb = scaleCanvas(page.out, 320).toDataURL('image/jpeg', 0.7);
}

// ------------------------------------------------------------------ Danh sách trang
function renderPages() {
  const wrap = $('#pages');
  wrap.innerHTML = '';
  state.pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.innerHTML = `
      <span class="no">${i + 1}</span>
      <img src="${p.thumb}" alt="Trang ${i + 1}" />
      <div class="acts">
        <button data-a="left" title="Lên trước">◀</button>
        <button data-a="edit" title="Chỉnh sửa">✏️</button>
        <button data-a="del" title="Xóa">🗑️</button>
        <button data-a="right" title="Ra sau">▶</button>
      </div>`;
    el.querySelector('img').addEventListener('click', () => openEditor(p));
    el.querySelector('.acts').addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      const idx = state.pages.indexOf(p);
      if (a === 'edit') return openEditor(p);
      if (a === 'del') state.pages.splice(idx, 1);
      if (a === 'left' && idx > 0) [state.pages[idx - 1], state.pages[idx]] = [state.pages[idx], state.pages[idx - 1]];
      if (a === 'right' && idx < state.pages.length - 1)
        [state.pages[idx + 1], state.pages[idx]] = [state.pages[idx], state.pages[idx + 1]];
      renderPages();
    });
    wrap.appendChild(el);
  });
  const has = state.pages.length > 0;
  $('#pageCount').textContent = state.pages.length;
  $('#pagesCard').hidden = !has;
  $('#aiCard').hidden = !has;
  $('#saveCard').hidden = !has;
  if (!has) $('#aiResult').hidden = true;
  setStep(!has ? 1 : state.analysis ? 3 : 2);
  if (has && !$('#fileName').value) $('#fileName').value = defaultFileName();
}

$('#btnClearPages').addEventListener('click', () => {
  if (!confirm('Xóa tất cả các trang đang quét?')) return;
  resetScan();
});

function resetScan() {
  state.pages = [];
  state.analysis = null;
  $('#fileName').value = '';
  $('#aiResult').hidden = true;
  renderPages();
}

$('#filterAll').addEventListener('change', (e) => {
  const f = e.target.value;
  if (!f) return;
  state.pages.forEach((p) => {
    p.filter = f;
    refreshPage(p);
  });
  renderPages();
  e.target.value = '';
});

$('#btnAutoAll').addEventListener('click', () => {
  let n = 0;
  state.pages.forEach((p) => {
    if (p.digital) return;
    const c = detectCorners(p.source);
    if (c) {
      p.corners = c;
      refreshPage(p);
      n++;
    }
  });
  renderPages();
  toast(n ? `Đã tự cắt ${n} trang` : 'Không dò được mép giấy – hãy chỉnh tay');
});

// ------------------------------------------------------------------ Trình chỉnh sửa trang
const ed = {
  page: null,
  corners: null,
  rotation: 0,
  filter: 'none',
  scale: 1,
  drag: -1,
};

function openEditor(page) {
  ed.page = page;
  ed.corners = page.corners.map((p) => ({ ...p }));
  ed.rotation = page.rotation;
  ed.filter = page.filter;
  $('#edFilter').value = ed.filter;
  $('#editor').showModal();
  requestAnimationFrame(drawEditor);
}

function drawEditor() {
  const src = ed.page.source;
  const stage = $('#edStage');
  const cv = $('#edCanvas');
  const maxW = stage.clientWidth - 8;
  const maxH = stage.clientHeight - 8;
  const s = Math.min(maxW / src.width, maxH / src.height);
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = src.width * s + 'px';
  cv.style.height = src.height * s + 'px';
  cv.width = Math.round(src.width * s * dpr);
  cv.height = Math.round(src.height * s * dpr);
  ed.scale = s;
  const ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  const P = ed.corners.map((p) => ({ x: p.x * cv.width, y: p.y * cv.height }));
  // Làm tối phần ngoài vùng chọn
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath();
  ctx.rect(0, 0, cv.width, cv.height);
  ctx.moveTo(P[0].x, P[0].y);
  for (let i = 3; i >= 1; i--) ctx.lineTo(P[i].x, P[i].y);
  ctx.closePath();
  ctx.fill('evenodd');
  ctx.restore();
  ctx.strokeStyle = '#14b8a6';
  ctx.lineWidth = 2.5 * dpr;
  ctx.beginPath();
  P.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.stroke();
  P.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, (ed.drag === i ? 16 : 12) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,184,166,0.35)';
    ctx.fill();
    ctx.lineWidth = 3 * dpr;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  });
  // Kính lúp khi đang kéo góc
  if (ed.drag >= 0) {
    const p = P[ed.drag];
    const r = 55 * dpr;
    const cx = p.x < cv.width / 2 ? cv.width - r - 10 : r + 10;
    const cy = r + 10;
    const zoom = 2.5;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    const sx = (p.x / cv.width) * src.width;
    const sy = (p.y / cv.height) * src.height;
    const half = r / (zoom * s * dpr);
    ctx.drawImage(src, sx - half, sy - half, half * 2, half * 2, cx - r, cy - r, r * 2, r * 2);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx - 10 * dpr, cy);
    ctx.lineTo(cx + 10 * dpr, cy);
    ctx.moveTo(cx, cy - 10 * dpr);
    ctx.lineTo(cx, cy + 10 * dpr);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3 * dpr;
    ctx.stroke();
  }
}

function edPoint(e) {
  const r = $('#edCanvas').getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), r };
}
$('#edCanvas').addEventListener('pointerdown', (e) => {
  const p = edPoint(e);
  let best = -1;
  let bestD = 40; // px
  ed.corners.forEach((c, i) => {
    const d = Math.hypot((c.x - p.x) * p.r.width, (c.y - p.y) * p.r.height);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best >= 0) {
    ed.drag = best;
    e.target.setPointerCapture(e.pointerId);
    drawEditor();
  }
});
$('#edCanvas').addEventListener('pointermove', (e) => {
  if (ed.drag < 0) return;
  const p = edPoint(e);
  ed.corners[ed.drag] = { x: p.x, y: p.y };
  drawEditor();
});
const endDrag = () => {
  if (ed.drag < 0) return;
  ed.drag = -1;
  drawEditor();
};
$('#edCanvas').addEventListener('pointerup', endDrag);
$('#edCanvas').addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => $('#editor').open && drawEditor());

$('#edAuto').addEventListener('click', () => {
  const c = detectCorners(ed.page.source);
  if (c) ed.corners = c;
  else toast('Không dò được mép giấy – hãy kéo tay 4 góc');
  drawEditor();
});
$('#edFull').addEventListener('click', () => {
  ed.corners = FULL_CORNERS();
  drawEditor();
});
$('#edRotL').addEventListener('click', () => {
  ed.rotation = (ed.rotation + 270) % 360;
  toast(`Xoay ${ed.rotation}°`);
});
$('#edRotR').addEventListener('click', () => {
  ed.rotation = (ed.rotation + 90) % 360;
  toast(`Xoay ${ed.rotation}°`);
});
$('#edFilter').addEventListener('change', (e) => (ed.filter = e.target.value));
$('#edCancel').addEventListener('click', () => $('#editor').close());
$('#edDone').addEventListener('click', () => {
  const p = ed.page;
  p.corners = ed.corners;
  p.rotation = ed.rotation;
  p.filter = ed.filter;
  refreshPage(p);
  state.analysis = null;
  $('#editor').close();
  renderPages();
});

// ------------------------------------------------------------------ Camera trực tiếp
const cam = { stream: null, facing: 'environment', timer: null, count: 0 };

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#in-camera').click();
    return;
  }
  cam.count = 0;
  $('#camCount').textContent = '0';
  $('#camera').showModal();
  await startStream();
}

async function startStream() {
  stopStream();
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cam.facing, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    $('#camVideo').srcObject = cam.stream;
    cam.timer = setInterval(liveDetect, 450);
  } catch (err) {
    $('#camera').close();
    toast('Không mở được camera – dùng chế độ chụp nhanh');
    $('#in-camera').click();
  }
}

function stopStream() {
  clearInterval(cam.timer);
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = null;
}

function videoFrame(maxSide) {
  const v = $('#camVideo');
  if (!v.videoWidth) return null;
  const s = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
  const c = makeCanvas(v.videoWidth * s, v.videoHeight * s);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return c;
}

function liveDetect() {
  const v = $('#camVideo');
  const ov = $('#camOverlay');
  const frame = videoFrame(260);
  ov.width = ov.clientWidth;
  ov.height = ov.clientHeight;
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  if (!frame) return;
  const q = detectCorners(frame);
  if (!q) return;
  // Chuyển tọa độ theo object-fit: contain
  const s = Math.min(ov.width / v.videoWidth, ov.height / v.videoHeight);
  const w = v.videoWidth * s;
  const h = v.videoHeight * s;
  const ox = (ov.width - w) / 2;
  const oy = (ov.height - h) / 2;
  ctx.fillStyle = 'rgba(20,184,166,0.18)';
  ctx.strokeStyle = '#14b8a6';
  ctx.lineWidth = 3;
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * w, oy + p.y * h) : ctx.moveTo(ox + p.x * w, oy + p.y * h)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

$('#camShot').addEventListener('click', async () => {
  const frame = videoFrame(2600);
  if (!frame) return;
  if (navigator.vibrate) navigator.vibrate(30);
  await addPage(frame, { photo: true });
  cam.count++;
  $('#camCount').textContent = cam.count;
  toast(`Đã chụp trang ${state.pages.length}`, 1200);
});
$('#camFlip').addEventListener('click', () => {
  cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
  startStream();
});
$('#camClose').addEventListener('click', () => $('#camera').close());
$('#camera').addEventListener('close', stopStream);

// ------------------------------------------------------------------ Bước 3: AI
function fillTypeSelect(sel, withAll) {
  sel.innerHTML = (withAll ? '<option value="">Tất cả loại</option>' : '') +
    DOC_TYPES.map((t) => `<option>${escapeHtml(t)}</option>`).join('');
}
fillTypeSelect($('#docType'), false);
fillTypeSelect($('#filterType'), true);

$('#btnOcr').addEventListener('click', () => runAi('local'));
$('#btnClaude').addEventListener('click', () => runAi('claude'));

async function runAi(mode) {
  if (!state.pages.length) return;
  const prog = $('#aiProgress');
  const btns = [$('#btnOcr'), $('#btnClaude')];
  btns.forEach((b) => (b.disabled = true));
  try {
    const nativeText = state.pages.filter((p) => p.digital && p.text).map((p) => p.text).join('\n\n');
    let result;
    if (mode === 'claude') {
      result = await claudeAnalyze({
        apiKey: settings.apiKey,
        model: settings.model,
        canvases: state.pages.map((p) => p.out),
        nativeText,
        onProgress: (f, t) => progress(prog, f, t),
      });
    } else {
      // Trang có chữ gốc (PDF chữ, Word, Excel) dùng luôn, chỉ OCR trang ảnh
      const toOcr = state.pages.filter((p) => !p.digital);
      if (toOcr.length) {
        const texts = await ocrPages(toOcr.map((p) => p.out), settings.ocrLang, (f, t) => progress(prog, f, t));
        toOcr.forEach((p, i) => (p.ocrText = texts[i]));
      }
      const text = state.pages.map((p) => (p.digital ? p.text : p.ocrText) || '').filter(Boolean).join('\n\n');
      result = localAnalyze(text);
    }
    state.analysis = result;
    showAnalysis(result);
    setStep(3);
    toast(mode === 'claude' ? 'Claude đã đọc xong tài liệu' : 'Đã nhận dạng xong');
  } catch (err) {
    console.error(err);
    toast('Lỗi AI: ' + (err.message || err), 6000);
  } finally {
    prog.hidden = true;
    btns.forEach((b) => (b.disabled = false));
  }
}

function showAnalysis(r) {
  $('#aiResult').hidden = false;
  $('#docType').value = DOC_TYPES.includes(r.doc_type) ? r.doc_type : 'Khác';
  $('#docDate').value = r.date || '';
  $('#docTitle').value = r.title || '';
  $('#docSummary').value = r.summary || '';
  $('#docText').value = r.full_text || '';
  const tb = $('#docFields');
  tb.innerHTML = '';
  (r.fields || []).forEach((f) => addFieldRow(f.label, f.value));
  $('#fileName').value = r.suggested_filename ? slugify(r.suggested_filename) + '.pdf' : defaultFileName();
}

function addFieldRow(label = '', value = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input class="fl" value="${escapeHtml(label)}" placeholder="Nhãn" /></td>
    <td><input class="fv" value="${escapeHtml(value)}" placeholder="Giá trị" /></td>
    <td><button class="del" title="Xóa">✕</button></td>`;
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
  $('#docFields').appendChild(tr);
}
$('#btnAddField').addEventListener('click', () => addFieldRow());
$('#btnCopyText').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#docText').value);
    toast('Đã sao chép văn bản');
  } catch {
    toast('Không sao chép được');
  }
});
['#docType', '#docDate', '#docTitle'].forEach((s) =>
  $(s).addEventListener('change', () => ($('#fileName').value = defaultFileName())),
);

function currentMeta() {
  const hasAi = !$('#aiResult').hidden;
  return {
    docType: hasAi ? $('#docType').value : 'Khác',
    date: hasAi ? $('#docDate').value : '',
    title: hasAi ? $('#docTitle').value : '',
    summary: hasAi ? $('#docSummary').value : '',
    text: hasAi ? $('#docText').value : '',
    fields: $$('#docFields tr')
      .map((tr) => ({ label: tr.querySelector('.fl').value.trim(), value: tr.querySelector('.fv').value.trim() }))
      .filter((f) => f.label || f.value),
    tags: state.analysis?.tags || [],
  };
}

function defaultFileName() {
  const m = currentMeta();
  const parts = [slugify(m.docType === 'Khác' ? 'Scan' : m.docType), toIsoDate(m.date)];
  if (m.title) parts.push(slugify(m.title).slice(0, 40));
  else parts.push(new Date().toTimeString().slice(0, 8).replace(/:/g, ''));
  return parts.filter(Boolean).join('_') + '.pdf';
}

// ------------------------------------------------------------------ Bước 4: tạo PDF & lưu
async function buildPdf(meta) {
  await loadScript(LIBS.jspdf);
  const { jsPDF } = window.jspdf;
  const size = $('#pageSize').value;
  const q = Number($('#quality').value);
  const SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
  let doc = null;
  for (const p of state.pages) {
    const img = scaleCanvas(p.out, q >= 0.9 ? 2400 : q <= 0.6 ? 1400 : 1900);
    const landscape = img.width > img.height;
    let pw, ph;
    if (size === 'fit') {
      pw = (img.width * 72) / 150;
      ph = (img.height * 72) / 150;
    } else {
      [pw, ph] = SIZES[size];
      if (landscape) [pw, ph] = [ph, pw];
    }
    const orientation = pw > ph ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: [pw, ph], orientation, compress: true });
    else doc.addPage([pw, ph], orientation);
    const s = Math.min(pw / img.width, ph / img.height);
    const w = img.width * s;
    const h = img.height * s;
    const data = img.toDataURL('image/jpeg', q);
    doc.addImage(data, 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, undefined, 'FAST');
  }
  doc.setProperties({
    title: meta.title || meta.docType,
    subject: meta.summary.slice(0, 500),
    keywords: [meta.docType, ...meta.tags].join(', '),
    creator: 'PDF Scanner AI',
  });
  return doc.output('blob');
}

function logLine(msg, cls = '') {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = msg;
  $('#saveLog').appendChild(d);
}

$('#btnSave').addEventListener('click', async () => {
  if (!state.pages.length) return;
  const btn = $('#btnSave');
  btn.disabled = true;
  $('#saveLog').innerHTML = '';
  try {
    const meta = currentMeta();
    let name = $('#fileName').value.trim() || defaultFileName();
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    logLine('⏳ Đang tạo PDF…');
    const pdf = await buildPdf(meta);
    const kb = Math.round(pdf.size / 1024);
    logLine(`✅ Đã tạo PDF ${state.pages.length} trang (${kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb + ' KB'})`, 'ok');
    const record = {
      id: uid(),
      name,
      createdAt: Date.now(),
      pages: state.pages.length,
      size: pdf.size,
      thumb: state.pages[0].thumb,
      ...meta,
      pdf,
      drive: null,
    };
    const json = new Blob(
      [JSON.stringify({ name, docType: meta.docType, date: meta.date, title: meta.title, summary: meta.summary, fields: meta.fields, tags: meta.tags, text: meta.text }, null, 2)],
      { type: 'application/json' },
    );

    if ($('#optLocal').checked) {
      await requestPersistentStorage();
      await db.put(record);
      logLine('✅ Đã lưu vào Thư viện trong app', 'ok');
    }
    if ($('#optDrive').checked) {
      try {
        logLine('⏳ Đang tải lên Google Drive…');
        const res = await uploadToDrive({
          clientId: settings.clientId,
          rootFolder: settings.folder,
          useSubfolder: settings.subfolder,
          docType: meta.docType,
          pdfBlob: pdf,
          pdfName: name,
          description: [meta.title, meta.summary, ...meta.fields.map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join('\n'),
          jsonBlob: $('#optTxt').checked ? json : null,
          props: { loai: meta.docType, ngay: meta.date },
        });
        record.drive = res;
        if ($('#optLocal').checked) await db.put(record);
        logLine(`✅ Đã lưu lên Google Drive – <a href="${res.webViewLink}" target="_blank" rel="noopener">mở file</a>`, 'ok');
        updateDriveStatus();
      } catch (err) {
        logLine('❌ Google Drive: ' + escapeHtml(err.message), 'err');
      }
    }
    if ($('#optDevice').checked) {
      const how = await saveToDevice(pdf, name);
      if (how !== 'cancelled') logLine('✅ ' + (how === 'shared' ? 'Đã mở bảng chia sẻ (chọn "Lưu vào Tệp")' : 'Đã tải file về máy'), 'ok');
      if ($('#optTxt').checked && !$('#optDrive').checked) await saveToDevice(json, name.replace(/\.pdf$/i, '.json'));
    }
    setStep(4);
    toast('Hoàn tất!');
    const again = document.createElement('button');
    again.className = 'btn ghost';
    again.textContent = '📷 Quét tài liệu mới';
    again.addEventListener('click', () => {
      resetScan();
      $('#saveLog').innerHTML = '';
      window.scrollTo(0, 0);
    });
    $('#saveLog').appendChild(again);
  } catch (err) {
    console.error(err);
    logLine('❌ ' + escapeHtml(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ Thư viện
$('#search').addEventListener('input', renderLibrary);
$('#filterType').addEventListener('change', renderLibrary);

async function renderLibrary() {
  const q = $('#search').value.trim().toLowerCase();
  const type = $('#filterType').value;
  const all = await db.all();
  const list = all.filter((d) => {
    if (type && d.docType !== type) return false;
    if (!q) return true;
    const hay = [d.name, d.title, d.summary, d.text, d.docType, ...(d.fields || []).map((f) => f.label + ' ' + f.value)]
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
  const wrap = $('#library');
  wrap.innerHTML = '';
  $('#libEmpty').hidden = list.length > 0;
  $('#libEmpty').textContent = all.length ? 'Không tìm thấy tài liệu phù hợp.' : 'Chưa có tài liệu nào. Hãy quét tài liệu đầu tiên!';
  for (const d of list) {
    const el = document.createElement('div');
    el.className = 'doc';
    const date = new Date(d.createdAt).toLocaleString('vi-VN');
    el.innerHTML = `
      <img src="${d.thumb}" alt="" />
      <div class="meta">
        <div class="name">${escapeHtml(d.name)}</div>
        <div class="sub"><span class="tag">${escapeHtml(d.docType)}</span>${d.pages} trang · ${Math.round(d.size / 1024)} KB · ${date}${d.drive ? ' · ☁️ Drive' : ''}</div>
        <div class="sum">${escapeHtml(d.summary || d.title || '')}</div>
        <div class="acts">
          <button class="btn small" data-a="open">Mở</button>
          <button class="btn small" data-a="share">Chia sẻ</button>
          ${d.drive ? `<a class="btn small" href="${d.drive.webViewLink}" target="_blank" rel="noopener">Xem trên Drive</a>` : '<button class="btn small" data-a="drive">Lên Drive</button>'}
          <button class="btn small ghost" data-a="del">Xóa</button>
        </div>
      </div>`;
    el.querySelector('.acts').addEventListener('click', async (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'open') window.open(URL.createObjectURL(d.pdf), '_blank');
      if (a === 'share') await saveToDevice(d.pdf, d.name);
      if (a === 'del' && confirm('Xóa "' + d.name + '" khỏi thư viện?')) {
        await db.del(d.id);
        renderLibrary();
      }
      if (a === 'drive') {
        try {
          toast('Đang tải lên Drive…');
          d.drive = await uploadToDrive({
            clientId: settings.clientId,
            rootFolder: settings.folder,
            useSubfolder: settings.subfolder,
            docType: d.docType,
            pdfBlob: d.pdf,
            pdfName: d.name,
            description: [d.title, d.summary].filter(Boolean).join('\n'),
            props: { loai: d.docType, ngay: d.date },
          });
          await db.put(d);
          toast('Đã tải lên Google Drive');
          renderLibrary();
        } catch (err) {
          toast(err.message, 5000);
        }
      }
    });
    wrap.appendChild(el);
  }
}

// ------------------------------------------------------------------ Cài đặt
function fillSettings() {
  $('#setApiKey').value = settings.apiKey;
  $('#setModel').value = settings.model;
  $('#setClientId').value = settings.clientId;
  $('#setFolder').value = settings.folder;
  $('#setSubfolder').checked = settings.subfolder;
  $('#setOcrLang').value = settings.ocrLang;
  $('#setFilter').value = settings.filter;
  $('#setAutoCrop').checked = settings.autoCrop;
}
fillSettings();

function readSettings() {
  settings = {
    apiKey: $('#setApiKey').value.trim(),
    model: $('#setModel').value,
    clientId: $('#setClientId').value.trim(),
    folder: $('#setFolder').value.trim() || 'PDF Scanner',
    subfolder: $('#setSubfolder').checked,
    ocrLang: $('#setOcrLang').value,
    filter: $('#setFilter').value,
    autoCrop: $('#setAutoCrop').checked,
  };
  storeSettings();
}
$('#btnSaveSettings').addEventListener('click', () => {
  readSettings();
  toast('Đã lưu cài đặt');
});

function updateDriveStatus() {
  $('#driveStatus').textContent = driveSignedIn() ? '✓ Đã kết nối' : 'Chưa đăng nhập';
}
$('#btnDriveLogin').addEventListener('click', async () => {
  readSettings();
  try {
    await driveSignIn(settings.clientId, 'consent');
    toast('Đã kết nối Google Drive');
  } catch (err) {
    toast(err.message, 5000);
  }
  updateDriveStatus();
});

// ------------------------------------------------------------------ PWA
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Hỗ trợ "Chia sẻ tới PDF Scanner" / mở file từ ứng dụng khác (Android, khi đã cài app)
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    const files = await Promise.all((params.files || []).map((h) => h.getFile()));
    if (files.length) importFiles(files);
  });
}

// File được chia sẻ vào app (menu "Chia sẻ" của Android) – service worker đã cất vào cache
if (new URLSearchParams(location.search).has('shared') && 'caches' in window) {
  (async () => {
    const cache = await caches.open('pdf-scanner-share');
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('x-name') || 'shared'), { type: blob.type }));
      await cache.delete(req);
    }
    history.replaceState(null, '', location.pathname);
    importFiles(files);
  })();
}

renderPages();

// Dùng cho kiểm thử tự động
window.__pdfScanner = { state, importFiles, applyFilter };
