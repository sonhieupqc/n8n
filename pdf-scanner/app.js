import {
  FULL_CORNERS,
  blobToCanvas,
  canvasToBlob,
  detectCorners,
  hashDistance,
  imageFileToCanvas,
  imageHash,
  makeCanvas,
  processPage,
  scaleCanvas,
  sharpnessScore,
} from './imaging.js';
import { LIBS, excelToPages, fileKind, loadScript, pdfToPages, textToPages, wordToPages } from './converters.js';
import { DOC_TYPES, askDocument, claudeAnalyze, fold, localAnalyze, ocrImages, parseEntities } from './ai.js';
import { buildPdf } from './pdfbuild.js';
import {
  buildIcs,
  db,
  drafts,
  drivePath,
  driveSignIn,
  driveSignedIn,
  requestPersistentStorage,
  saveToDevice,
  uploadToDrive,
} from './storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const PREVIEW_SIDE = 1400; // cạnh dài ảnh dùng trong trình chỉnh sửa
const THUMB_SIDE = 360;
const BLUR_THRESHOLD = 90; // dưới ngưỡng này coi là ảnh mờ

// ------------------------------------------------------------------ Trạng thái
// Mỗi trang chỉ giữ ảnh nén (Blob) + ảnh nhỏ, không giữ canvas lớn trong RAM
// => quét hàng chục trang trên điện thoại không bị treo.
const state = {
  pages: [], // { id, blob, corners, rotation, filter, text, digital, photo, blurry, thumb, outBlob, ocr }
  analysis: null,
  fileNameTouched: false,
};

const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-5',
  autoAi: false,
  entities: 'Cá nhân\nGia đình',
  clientId: '',
  folder: 'PDF Scanner',
  driveStructure: 'entity-type-year',
  ocrLang: 'vie+eng',
  filter: 'magic',
  autoCrop: true,
  autoShot: true,
};
let settings = loadSettings();

function loadSettings() {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pdfscanner.settings') || '{}') };
    if (s.subfolder === false && !s.driveStructureSet) s.driveStructure = 'none';
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}
function storeSettings() {
  try {
    localStorage.setItem('pdfscanner.settings', JSON.stringify({ ...settings, driveStructureSet: true }));
  } catch {}
}
const entities = () => parseEntities(settings.entities);

// ------------------------------------------------------------------ Tiện ích UI
let toastTimer;
function toast(msg, ms = 2600, action) {
  const t = $('#toast');
  t.querySelector('.msg').textContent = msg;
  const btn = t.querySelector('.act');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      t.classList.remove('show');
      action.fn();
    };
  }
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
const tick = () => new Promise((r) => setTimeout(r, 0));

export function slugify(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9_]+/g, '-')
    .replace(/-?_-?/g, '_')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function parseVnDate(d) {
  const m = String(d || '').match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  const dt = new Date(y, +m[2] - 1, +m[1]);
  return isNaN(dt) ? null : dt;
}

function toIsoDate(d) {
  const dt = parseVnDate(d) || new Date();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtSize(bytes) {
  const kb = bytes / 1024;
  return kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
}

// ------------------------------------------------------------------ Tab
function showTab(name) {
  $$('.tabbar button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'library') renderLibrary();
  if (name === 'settings') showStorageInfo();
  window.scrollTo(0, 0);
}
$$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

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
  const prog = $('#importProgress');
  let added = 0;
  for (const [fi, file] of files.entries()) {
    const kind = fileKind(file);
    const say = (t) => progress(prog, fi / files.length, `${file.name}: ${t}`);
    try {
      say('đang xử lý…');
      let list = [];
      if (kind === 'image') list = [{ canvas: await imageFileToCanvas(file), photo: true }];
      else if (kind === 'pdf') list = await pdfToPages(file, say);
      else if (kind === 'word') list = await wordToPages(file, say);
      else if (kind === 'excel') list = await excelToPages(file, say);
      else if (kind === 'text') list = await textToPages(file, say);
      else if (kind === 'doc-legacy') toast('File .doc đời cũ chưa hỗ trợ – hãy mở bằng Word và lưu lại dạng .docx', 5000);
      else toast('Không hỗ trợ định dạng: ' + file.name);
      for (const [i, p] of list.entries()) {
        say(`thêm trang ${i + 1}/${list.length}`);
        // Trang PDF scan (không có chữ) được xử lý như ảnh chụp: tự cắt + lọc
        const scanned = kind === 'pdf' && !p.digital;
        await addPage(p.canvas, { photo: !!p.photo, scanned, text: p.text || '', digital: !!p.digital });
        p.canvas = null;
        added++;
      }
    } catch (err) {
      console.error(err);
      toast('Lỗi: ' + err.message, 5000);
    }
  }
  prog.hidden = true;
  if (added) {
    toast(`Đã thêm ${added} trang`);
    if (settings.autoAi && settings.apiKey && navigator.onLine) runAi('claude');
  }
}

async function addPage(canvas, { photo = false, scanned = false, text = '', digital = false } = {}) {
  let corners = FULL_CORNERS();
  let blurry = false;
  if (photo) {
    if (settings.autoCrop) corners = detectCorners(canvas) || FULL_CORNERS();
    blurry = sharpnessScore(canvas) < BLUR_THRESHOLD;
  }
  const page = {
    id: uid(),
    blob: await canvasToBlob(canvas, 'image/jpeg', 0.92),
    corners,
    rotation: 0,
    filter: photo ? settings.filter : scanned ? 'enhance' : 'none',
    text,
    digital,
    photo,
    blurry,
    thumb: '',
    outBlob: null,
    ocr: null,
  };
  page.thumb = thumbFrom(scaleCanvas(canvas, 700), page);
  state.pages.push(page);
  state.analysis = null;
  state.hash = null;
  saveDraft(page);
  renderPages();
  await tick();
  return page;
}

function thumbFrom(preview, page) {
  return scaleCanvas(processPage(preview, page), THUMB_SIDE).toDataURL('image/jpeg', 0.72);
}

async function refreshThumb(page, preview) {
  const src = preview || scaleCanvas(await blobToCanvas(page.blob), 700);
  page.thumb = thumbFrom(src, page);
  page.outBlob = null;
  page.ocr = null;
}

/** Ảnh trang đã xử lý ở độ phân giải đầy đủ (có bộ nhớ đệm). */
async function getProcessed(page) {
  if (!page.outBlob) {
    const src = await blobToCanvas(page.blob);
    page.outBlob = await canvasToBlob(processPage(src, page), 'image/jpeg', 0.92);
  }
  return page.outBlob;
}

// ------------------------------------------------------------------ Phiên quét dở (khôi phục khi app bị tắt)
function saveDraft(page) {
  const order = state.pages.indexOf(page);
  const { outBlob, ocr, ...rest } = page;
  drafts.put({ ...rest, order }).catch(() => {});
}
function saveAllDrafts() {
  state.pages.forEach(saveDraft);
}

async function checkDraft() {
  try {
    const list = await drafts.all();
    if (!list.length || state.pages.length) return;
    $('#draftCount').textContent = list.length;
    $('#draftBanner').hidden = false;
  } catch {}
}
$('#btnDraftRestore').addEventListener('click', async () => {
  const list = await drafts.all();
  state.pages = list.map((p) => ({ ...p, outBlob: null, ocr: null }));
  $('#draftBanner').hidden = true;
  renderPages();
  toast(`Đã khôi phục ${list.length} trang`);
});
$('#btnDraftDiscard').addEventListener('click', async () => {
  await drafts.clear();
  $('#draftBanner').hidden = true;
});

// ------------------------------------------------------------------ Bước 2: danh sách trang
function renderPages() {
  const wrap = $('#pages');
  wrap.innerHTML = '';
  state.pages.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.innerHTML = `
      <span class="no">${i + 1}</span>
      ${p.blurry ? '<span class="warnb" title="Ảnh có thể bị mờ">⚠ mờ</span>' : ''}
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
      if (a === 'del') {
        state.pages.splice(idx, 1);
        drafts.del(p.id).catch(() => {});
        toast(`Đã xóa trang ${idx + 1}`, 4000, {
          label: 'Hoàn tác',
          fn: () => {
            state.pages.splice(idx, 0, p);
            saveAllDrafts();
            renderPages();
          },
        });
      }
      if (a === 'left' && idx > 0) [state.pages[idx - 1], state.pages[idx]] = [state.pages[idx], state.pages[idx - 1]];
      if (a === 'right' && idx < state.pages.length - 1)
        [state.pages[idx + 1], state.pages[idx]] = [state.pages[idx], state.pages[idx + 1]];
      if (a !== 'del') saveAllDrafts();
      state.hash = null;
      renderPages();
    });
    wrap.appendChild(el);
  });
  const has = state.pages.length > 0;
  $('#pageCount').textContent = state.pages.length;
  $('#pagesCard').hidden = !has;
  $('#aiCard').hidden = !has;
  $('#saveCard').hidden = !has;
  if (has) $('#draftBanner').hidden = true;
  if (!has) $('#aiResult').hidden = true;
  setStep(!has ? 1 : state.analysis ? 3 : 2);
  if (has && !state.fileNameTouched) $('#fileName').value = defaultFileName();
}

$('#btnClearPages').addEventListener('click', () => {
  if (!confirm('Xóa tất cả các trang đang quét?')) return;
  resetScan();
});

function resetScan() {
  state.pages = [];
  state.analysis = null;
  state.hash = null;
  state.fileNameTouched = false;
  $('#fileName').value = '';
  $('#optPassword').value = '';
  $('#aiResult').hidden = true;
  $('#saveLog').innerHTML = '';
  drafts.clear().catch(() => {});
  renderPages();
}

$('#filterAll').addEventListener('change', async (e) => {
  const f = e.target.value;
  if (!f) return;
  e.target.value = '';
  const prog = $('#importProgress');
  for (const [i, p] of state.pages.entries()) {
    progress(prog, i / state.pages.length, `Áp bộ lọc trang ${i + 1}/${state.pages.length}`);
    p.filter = f;
    await refreshThumb(p);
    saveDraft(p);
  }
  prog.hidden = true;
  renderPages();
});

$('#btnAutoAll').addEventListener('click', async () => {
  let n = 0;
  for (const p of state.pages) {
    if (p.digital) continue;
    const preview = scaleCanvas(await blobToCanvas(p.blob), 700);
    const c = detectCorners(preview);
    if (c) {
      p.corners = c;
      await refreshThumb(p, preview);
      saveDraft(p);
      n++;
    }
  }
  renderPages();
  toast(n ? `Đã tự cắt ${n} trang` : 'Không dò được mép giấy – hãy chỉnh tay');
});

// ------------------------------------------------------------------ Trình chỉnh sửa trang
const ed = { page: null, src: null, corners: null, rotation: 0, filter: 'none', drag: -1, result: false };

async function openEditor(page) {
  ed.page = page;
  ed.src = scaleCanvas(await blobToCanvas(page.blob), PREVIEW_SIDE);
  ed.corners = page.corners.map((p) => ({ ...p }));
  ed.rotation = page.rotation;
  ed.filter = page.filter;
  ed.result = false;
  $('#edFilter').value = ed.filter;
  $('#edToggle').textContent = '👁 Xem kết quả';
  $('#editor').showModal();
  requestAnimationFrame(drawEditor);
}

function drawEditor() {
  const stage = $('#edStage');
  const cv = $('#edCanvas');
  const src = ed.result ? processPage(ed.src, { corners: ed.corners, rotation: ed.rotation, filter: ed.filter }) : ed.src;
  const s = Math.min((stage.clientWidth - 8) / src.width, (stage.clientHeight - 8) / src.height);
  const dpr = window.devicePixelRatio || 1;
  cv.style.width = src.width * s + 'px';
  cv.style.height = src.height * s + 'px';
  cv.width = Math.round(src.width * s * dpr);
  cv.height = Math.round(src.height * s * dpr);
  const ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  $('#edHint').textContent = ed.result ? 'Đây là kết quả sau khi cắt, xoay và lọc.' : 'Kéo 4 góc tròn trùng với 4 góc tờ giấy.';
  if (ed.result) return;
  const P = ed.corners.map((p) => ({ x: p.x * cv.width, y: p.y * cv.height }));
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
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    const sx = (p.x / cv.width) * src.width;
    const sy = (p.y / cv.height) * src.height;
    const half = r / (2.5 * s * dpr);
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
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    r,
  };
}
$('#edCanvas').addEventListener('pointerdown', (e) => {
  if (ed.result) return;
  const p = edPoint(e);
  let best = -1;
  let bestD = 44;
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

$('#edToggle').addEventListener('click', () => {
  ed.result = !ed.result;
  $('#edToggle').textContent = ed.result ? '✂️ Chỉnh góc' : '👁 Xem kết quả';
  drawEditor();
});
$('#edAuto').addEventListener('click', () => {
  const c = detectCorners(ed.src);
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
  if (ed.result) drawEditor();
  else toast(`Xoay ${ed.rotation}° – bấm "Xem kết quả" để xem`);
});
$('#edRotR').addEventListener('click', () => {
  ed.rotation = (ed.rotation + 90) % 360;
  if (ed.result) drawEditor();
  else toast(`Xoay ${ed.rotation}° – bấm "Xem kết quả" để xem`);
});
$('#edFilter').addEventListener('change', (e) => {
  ed.filter = e.target.value;
  if (ed.result) drawEditor();
});
$('#edCancel').addEventListener('click', () => $('#editor').close());
$('#editor').addEventListener('close', () => (ed.src = null));
$('#edDone').addEventListener('click', async () => {
  const p = ed.page;
  p.corners = ed.corners;
  p.rotation = ed.rotation;
  p.filter = ed.filter;
  await refreshThumb(p, scaleCanvas(ed.src, 700));
  saveDraft(p);
  state.analysis = null;
  state.hash = null;
  $('#editor').close();
  renderPages();
});

// ------------------------------------------------------------------ Camera trực tiếp (tự chụp khi giữ yên)
const cam = { stream: null, timer: null, count: 0, auto: true, last: null, stable: 0, lock: null, busy: false, torch: false };
const STABLE_NEEDED = 5; // ~1.5 giây

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#in-camera').click();
    return;
  }
  cam.count = 0;
  cam.auto = settings.autoShot;
  cam.last = cam.lock = null;
  cam.stable = 0;
  $('#camCount').textContent = '0';
  $('#camAuto').textContent = 'Tự chụp: ' + (cam.auto ? 'BẬT' : 'TẮT');
  $('#camera').showModal();
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
    $('#camVideo').srcObject = cam.stream;
    const track = cam.stream.getVideoTracks()[0];
    $('#camTorch').hidden = !track.getCapabilities?.().torch;
    cam.timer = setInterval(liveDetect, 300);
  } catch {
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

const quadDelta = (a, b) => (a && b ? Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y))) : 1);

function setRing(frac) {
  $('#camRing circle').style.strokeDashoffset = String(226 * (1 - frac));
}

function liveDetect() {
  const v = $('#camVideo');
  const ov = $('#camOverlay');
  const frame = videoFrame(260);
  ov.width = ov.clientWidth;
  ov.height = ov.clientHeight;
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  if (!frame || cam.busy) return;
  const q = detectCorners(frame);
  if (!q) {
    cam.stable = 0;
    cam.last = null;
    cam.lock = null;
    setRing(0);
    $('#camMsg').textContent = 'Không thấy tài liệu – đặt giấy trên nền tối';
    return;
  }
  const s = Math.min(ov.width / v.videoWidth, ov.height / v.videoHeight);
  const w = v.videoWidth * s;
  const h = v.videoHeight * s;
  const ox = (ov.width - w) / 2;
  const oy = (ov.height - h) / 2;
  const locked = cam.lock && quadDelta(q, cam.lock) < 0.06;
  ctx.fillStyle = locked ? 'rgba(148,163,184,0.18)' : 'rgba(20,184,166,0.2)';
  ctx.strokeStyle = locked ? '#94a3b8' : '#14b8a6';
  ctx.lineWidth = 3;
  ctx.beginPath();
  q.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * w, oy + p.y * h) : ctx.moveTo(ox + p.x * w, oy + p.y * h)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  if (locked) {
    $('#camMsg').textContent = '✓ Đã chụp – lật sang trang tiếp theo';
    setRing(0);
    return;
  }
  cam.lock = null;
  cam.stable = quadDelta(q, cam.last) < 0.02 ? cam.stable + 1 : 0;
  cam.last = q;
  if (!cam.auto) {
    $('#camMsg').textContent = 'Đã thấy tài liệu – bấm nút để chụp';
    return;
  }
  setRing(Math.min(1, cam.stable / STABLE_NEEDED));
  $('#camMsg').textContent = cam.stable ? 'Giữ yên máy…' : 'Đã thấy tài liệu';
  if (cam.stable >= STABLE_NEEDED) {
    cam.lock = q;
    cam.stable = 0;
    shoot();
  }
}

async function shoot() {
  const frame = videoFrame(2600);
  if (!frame || cam.busy) return;
  cam.busy = true;
  try {
    if (navigator.vibrate) navigator.vibrate(40);
    const ov = $('#camOverlay');
    ov.getContext('2d').fillStyle = 'rgba(255,255,255,0.6)';
    ov.getContext('2d').fillRect(0, 0, ov.width, ov.height);
    const page = await addPage(frame, { photo: true });
    cam.count++;
    $('#camCount').textContent = cam.count;
    toast(page.blurry ? `⚠ Trang ${state.pages.length} hơi mờ – nên chụp lại` : `Đã chụp trang ${state.pages.length}`, 1500);
  } finally {
    cam.busy = false;
  }
}

$('#camShot').addEventListener('click', () => {
  cam.lock = cam.last;
  shoot();
});
$('#camAuto').addEventListener('click', () => {
  cam.auto = !cam.auto;
  cam.stable = 0;
  setRing(0);
  $('#camAuto').textContent = 'Tự chụp: ' + (cam.auto ? 'BẬT' : 'TẮT');
});
$('#camTorch').addEventListener('click', async () => {
  const track = cam.stream?.getVideoTracks()[0];
  if (!track) return;
  cam.torch = !cam.torch;
  try {
    await track.applyConstraints({ advanced: [{ torch: cam.torch }] });
  } catch {
    toast('Máy không hỗ trợ bật đèn');
  }
});
$('#camClose').addEventListener('click', () => $('#camera').close());
$('#camera').addEventListener('close', () => {
  stopStream();
  cam.torch = false;
  if (cam.count && settings.autoAi && settings.apiKey && navigator.onLine) runAi('claude');
});

// ------------------------------------------------------------------ Bước 3: AI
function fillTypeSelect(sel, allLabel) {
  sel.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : '') + DOC_TYPES.map((t) => `<option>${escapeHtml(t)}</option>`).join('');
}
fillTypeSelect($('#docType'));
fillTypeSelect($('#dlgType'));
fillTypeSelect($('#filterType'), 'Mọi loại');

function fillEntityList() {
  $('#entityList').innerHTML = entities().map((e) => `<option value="${escapeHtml(e.name)}"></option>`).join('');
}
fillEntityList();

$('#btnOcr').addEventListener('click', () => runAi('local'));
$('#btnClaude').addEventListener('click', () => runAi('claude'));

let aiRunning = false;
async function runAi(mode) {
  if (!state.pages.length || aiRunning) return;
  aiRunning = true;
  const prog = $('#aiProgress');
  const btns = [$('#btnOcr'), $('#btnClaude')];
  btns.forEach((b) => (b.disabled = true));
  try {
    const nativeText = state.pages.filter((p) => p.digital && p.text).map((p) => p.text).join('\n\n');
    let result;
    if (mode === 'claude') {
      if (!settings.apiKey) throw new Error('Chưa nhập Anthropic API key trong phần Cài đặt.');
      const images = [];
      for (const [i, p] of state.pages.entries()) {
        progress(prog, (0.05 * i) / state.pages.length, 'Đang chuẩn bị ảnh…');
        images.push(await getProcessed(p));
      }
      result = await claudeAnalyze({
        apiKey: settings.apiKey,
        model: settings.model,
        images,
        nativeText,
        entities: entities(),
        onProgress: (f, t) => progress(prog, f, t),
      });
    } else {
      await ensureOcr(state.pages.filter((p) => !p.digital), (f, t) => progress(prog, f, t));
      result = localAnalyze(combinedText(), entities());
    }
    state.analysis = result;
    showAnalysis(result);
    await checkDuplicate(result.full_text);
    setStep(3);
    toast(mode === 'claude' ? '✨ Claude đã đọc xong tài liệu' : 'Đã nhận dạng xong');
  } catch (err) {
    console.error(err);
    toast('Lỗi AI: ' + (err.message || err), 6000);
  } finally {
    prog.hidden = true;
    btns.forEach((b) => (b.disabled = false));
    aiRunning = false;
  }
}

/** OCR các trang chưa có kết quả (dùng cho phân tích và cho lớp chữ PDF). */
async function ensureOcr(pages, onProgress) {
  const need = pages.filter((p) => !p.ocr);
  if (!need.length) return;
  const blobs = [];
  for (const p of need) blobs.push(await getProcessed(p));
  const res = await ocrImages(blobs, settings.ocrLang, onProgress);
  need.forEach((p, i) => (p.ocr = res[i]));
}

function combinedText() {
  return state.pages
    .map((p) => (p.digital && p.text ? p.text : p.ocr?.text) || '')
    .filter(Boolean)
    .join('\n\n');
}

async function checkDuplicate(text) {
  const note = $('#dupNote');
  note.hidden = true;
  if (!state.pages[0]) return;
  const hash = imageHash(await blobToCanvas(await getProcessed(state.pages[0])));
  state.hash = hash;
  const key = fold(text || '').replace(/\s+/g, ' ').slice(0, 300);
  const all = await db.all();
  const dup = all.find(
    (d) => hashDistance(d.hash, hash) <= 5 || (key.length > 80 && fold(d.text || '').replace(/\s+/g, ' ').slice(0, 300) === key),
  );
  if (dup) {
    note.innerHTML = `♻️ Tài liệu này có vẻ <b>đã được lưu</b>: “${escapeHtml(dup.name)}” (${new Date(dup.createdAt).toLocaleDateString('vi-VN')}).`;
    note.hidden = false;
  }
}

function showAnalysis(r) {
  $('#aiResult').hidden = false;
  $('#docType').value = DOC_TYPES.includes(r.doc_type) ? r.doc_type : 'Khác';
  $('#docEntity').value = r.entity || '';
  $('#docDate').value = r.date || '';
  $('#docTitle').value = r.title || '';
  $('#docSummary').value = r.summary || '';
  $('#docTags').value = (r.tags || []).join(', ');
  $('#docText').value = r.full_text || '';
  $('#docFields').innerHTML = '';
  (r.fields || []).forEach((f) => addRow('#docFields', f.label, f.value, 'Nhãn', 'Giá trị'));
  $('#docDeadlines').innerHTML = '';
  (r.deadlines || []).forEach((d) => addRow('#docDeadlines', d.label, d.date, 'Việc cần nhớ', 'dd/mm/yyyy'));
  $('#sensitiveNote').hidden = !r.sensitive;
  if (r.sensitive) $('#advOpts').open = true;
  if (!state.fileNameTouched) {
    $('#fileName').value = r.suggested_filename ? slugify(r.suggested_filename) + '.pdf' : defaultFileName();
  }
}

function addRow(tbody, label = '', value = '', ph1 = '', ph2 = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input type="text" class="fl" value="${escapeHtml(label)}" placeholder="${ph1}" /></td>
    <td><input type="text" class="fv" value="${escapeHtml(value)}" placeholder="${ph2}" /></td>
    <td><button class="del" title="Xóa">✕</button></td>`;
  tr.querySelector('.del').addEventListener('click', () => tr.remove());
  $(tbody).appendChild(tr);
}
const readRows = (tbody) =>
  $$(tbody + ' tr')
    .map((tr) => ({ label: tr.querySelector('.fl').value.trim(), value: tr.querySelector('.fv').value.trim() }))
    .filter((f) => f.label || f.value);

$('#btnAddField').addEventListener('click', () => addRow('#docFields', '', '', 'Nhãn', 'Giá trị'));
$('#btnAddDeadline').addEventListener('click', () => addRow('#docDeadlines', '', '', 'Việc cần nhớ', 'dd/mm/yyyy'));
$('#btnCopyText').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#docText').value);
    toast('Đã sao chép văn bản');
  } catch {
    toast('Không sao chép được');
  }
});
['#docType', '#docDate', '#docTitle', '#docEntity'].forEach((s) =>
  $(s).addEventListener('change', () => {
    if (!state.fileNameTouched) $('#fileName').value = defaultFileName();
  }),
);
$('#fileName').addEventListener('input', () => (state.fileNameTouched = true));

function currentMeta() {
  const hasAi = !$('#aiResult').hidden;
  return {
    docType: hasAi ? $('#docType').value : 'Khác',
    entity: hasAi ? $('#docEntity').value.trim() : '',
    date: hasAi ? $('#docDate').value.trim() : '',
    title: hasAi ? $('#docTitle').value.trim() : '',
    summary: hasAi ? $('#docSummary').value.trim() : '',
    text: hasAi ? $('#docText').value : '',
    tags: hasAi ? $('#docTags').value.split(',').map((t) => t.trim()).filter(Boolean) : [],
    fields: hasAi ? readRows('#docFields') : [],
    deadlines: hasAi ? readRows('#docDeadlines').map((r) => ({ label: r.label, date: r.value })) : [],
    sensitive: hasAi ? !$('#sensitiveNote').hidden : false,
  };
}

function defaultFileName(meta = currentMeta()) {
  const parts = [slugify(meta.docType === 'Khác' ? 'Scan' : meta.docType), toIsoDate(meta.date)];
  if (meta.entity) parts.splice(1, 0, slugify(meta.entity).slice(0, 20));
  if (meta.title) parts.push(slugify(meta.title).slice(0, 40));
  else parts.push(new Date().toTimeString().slice(0, 8).replace(/:/g, ''));
  return parts.filter(Boolean).join('_') + '.pdf';
}

// ------------------------------------------------------------------ Bước 4: tạo PDF & lưu
function logLine(msg, cls = '') {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = msg;
  $('#saveLog').appendChild(d);
}

$('#btnSave').addEventListener('click', async () => {
  if (!state.pages.length) return;
  const btn = $('#btnSave');
  const prog = $('#saveProgress');
  btn.disabled = true;
  $('#saveLog').innerHTML = '';
  try {
    let meta = currentMeta();
    const searchable = $('#optSearchable').checked;

    // Lớp chữ OCR cho PDF tìm kiếm được
    if (searchable) {
      try {
        await ensureOcr(state.pages, (f, t) => progress(prog, f * 0.6, 'Tạo lớp chữ: ' + t));
      } catch (err) {
        logLine('⚠️ Không tạo được lớp chữ (cần mạng lần đầu để tải bộ OCR) – PDF vẫn được tạo dạng ảnh.', 'err');
      }
    }
    // Chưa chạy bước AI → tự phân tích nhanh trên máy để đặt tên, phân loại, tìm kiếm
    if ($('#aiResult').hidden) {
      const text = combinedText();
      if (text) {
        const r = localAnalyze(text, entities());
        state.analysis = r;
        showAnalysis(r);
        meta = currentMeta();
        logLine(`🔎 Tự nhận dạng: <b>${escapeHtml(r.doc_type)}</b>${r.entity ? ' · ' + escapeHtml(r.entity) : ''}`);
      }
    }
    if (!meta.text) meta.text = combinedText();

    let name = $('#fileName').value.trim() || defaultFileName(meta);
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    const pages = [];
    for (const [i, p] of state.pages.entries()) {
      progress(prog, 0.6 + (0.1 * i) / state.pages.length, `Chuẩn bị trang ${i + 1}/${state.pages.length}`);
      pages.push({ blob: await getProcessed(p), filter: p.filter });
    }
    const password = $('#optPassword').value.trim();
    const pdf = await buildPdf(
      pages,
      searchable ? state.pages.map((p) => p.ocr) : null,
      {
        size: $('#pageSize').value,
        quality: Number($('#quality').value),
        pageNumbers: $('#optPageNo').checked,
        watermark: $('#optWatermark').value.trim(),
        password,
        meta,
      },
      (f, t) => progress(prog, 0.7 + f * 0.3, t),
    );
    prog.hidden = true;
    const extras = [
      searchable && state.pages.some((p) => p.ocr?.words?.length) && 'tìm kiếm được',
      password && 'có mật khẩu',
      $('#optWatermark').value.trim() && 'có dấu chìm',
    ].filter(Boolean);
    logLine(`✅ Đã tạo PDF ${state.pages.length} trang (${fmtSize(pdf.size)})${extras.length ? ' – ' + extras.join(', ') : ''}`, 'ok');

    if (!state.hash) state.hash = imageHash(await blobToCanvas(pages[0].blob));
    const record = {
      id: uid(),
      name,
      createdAt: Date.now(),
      pages: state.pages.length,
      size: pdf.size,
      thumb: state.pages[0].thumb,
      hash: state.hash,
      protected: !!password,
      ...meta,
      pdf,
      drive: null,
    };
    const json = new Blob(
      [
        JSON.stringify(
          {
            name, docType: meta.docType, entity: meta.entity, date: meta.date, title: meta.title, summary: meta.summary,
            fields: meta.fields, deadlines: meta.deadlines, tags: meta.tags, text: meta.text,
          },
          null,
          2,
        ),
      ],
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
        const path = drivePath(settings.driveStructure, meta);
        const res = await uploadToDrive({
          clientId: settings.clientId,
          rootFolder: settings.folder,
          path,
          pdfBlob: pdf,
          pdfName: name,
          description: [meta.title, meta.summary, ...meta.fields.map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join('\n'),
          jsonBlob: $('#optTxt').checked ? json : null,
          props: { loai: meta.docType, ngay: meta.date, donvi: meta.entity },
        });
        record.drive = res;
        if ($('#optLocal').checked) await db.put(record);
        logLine(
          `✅ Đã lưu lên Google Drive (${escapeHtml([settings.folder, ...path].join(' / '))}) – <a href="${res.webViewLink}" target="_blank" rel="noopener">mở file</a>`,
          'ok',
        );
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
    if (meta.deadlines.length) {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = `📅 Thêm ${meta.deadlines.length} mốc vào lịch điện thoại`;
      b.addEventListener('click', () => exportIcs(record));
      $('#saveLog').appendChild(b);
    }
    drafts.clear().catch(() => {});
    setStep(4);
    toast('Hoàn tất!');
    const again = document.createElement('button');
    again.className = 'btn ghost';
    again.textContent = '📷 Quét tài liệu mới';
    again.style.marginLeft = '8px';
    again.addEventListener('click', () => {
      resetScan();
      window.scrollTo(0, 0);
    });
    $('#saveLog').appendChild(again);
  } catch (err) {
    console.error(err);
    logLine('❌ ' + escapeHtml(err.message), 'err');
  } finally {
    prog.hidden = true;
    btn.disabled = false;
  }
});

function exportIcs(doc) {
  const events = (doc.deadlines || []).map((d) => ({
    date: d.date,
    title: `${d.label} – ${doc.title || doc.docType}`,
    description: [doc.name, doc.entity, doc.summary].filter(Boolean).join('\n'),
  }));
  if (!events.length) return toast('Tài liệu không có mốc thời gian');
  saveToDevice(buildIcs(events), slugify(doc.title || doc.name).slice(0, 40) + '.ics');
}

// ------------------------------------------------------------------ Thư viện
$('#search').addEventListener('input', renderLibrary);
['#filterType', '#filterEntity', '#sortBy'].forEach((s) => $(s).addEventListener('change', renderLibrary));

let libCache = [];
function filteredDocs() {
  const q = fold($('#search').value.trim());
  const type = $('#filterType').value;
  const ent = $('#filterEntity').value;
  const words = q.split(/\s+/).filter(Boolean);
  const list = libCache.filter((d) => {
    if (type && d.docType !== type) return false;
    if (ent && (d.entity || '') !== ent) return false;
    if (!words.length) return true;
    const hay = fold(
      [d.name, d.title, d.summary, d.text, d.docType, d.entity, ...(d.tags || []), ...(d.fields || []).map((f) => f.label + ' ' + f.value)].join(' '),
    );
    return words.every((w) => hay.includes(w));
  });
  const by = $('#sortBy').value;
  const docDate = (d) => parseVnDate(d.date)?.getTime() || d.createdAt;
  list.sort((a, b) =>
    by === 'old' ? a.createdAt - b.createdAt : by === 'date' ? docDate(b) - docDate(a) : by === 'name' ? a.name.localeCompare(b.name, 'vi') : b.createdAt - a.createdAt,
  );
  return list;
}

async function renderLibrary() {
  libCache = await db.all();
  // Bộ lọc đơn vị lấy từ cài đặt + dữ liệu thực có
  const ents = [...new Set([...entities().map((e) => e.name), ...libCache.map((d) => d.entity).filter(Boolean)])];
  const sel = $('#filterEntity');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Mọi đơn vị</option>' + ents.map((e) => `<option>${escapeHtml(e)}</option>`).join('');
  sel.value = ents.includes(cur) ? cur : '';

  renderDue();
  const list = filteredDocs();
  const total = libCache.reduce((s, d) => s + (d.size || 0), 0);
  const byType = {};
  list.forEach((d) => (byType[d.docType] = (byType[d.docType] || 0) + 1));
  $('#libStats').innerHTML =
    `<span><b>${list.length}</b>/${libCache.length} tài liệu · ${fmtSize(total)}</span>` +
    Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([t, n]) => `<span class="tag">${escapeHtml(t)} ${n}</span>`)
      .join('');

  const wrap = $('#library');
  wrap.innerHTML = '';
  $('#libEmpty').hidden = list.length > 0;
  $('#libEmpty').textContent = libCache.length ? 'Không tìm thấy tài liệu phù hợp.' : 'Chưa có tài liệu nào. Hãy quét tài liệu đầu tiên!';
  for (const d of list) {
    const el = document.createElement('div');
    el.className = 'doc';
    el.innerHTML = `
      <img src="${d.thumb}" alt="" loading="lazy" />
      <div class="meta">
        <div class="name">${escapeHtml(d.title || d.name)}</div>
        <div class="sub">${d.pages} trang · ${fmtSize(d.size)} · ${d.date || new Date(d.createdAt).toLocaleDateString('vi-VN')}</div>
        <div class="sum">${escapeHtml(d.summary || d.name)}</div>
        <div class="badges">
          <span class="tag">${escapeHtml(d.docType)}</span>
          ${d.entity ? `<span class="tag">🏢 ${escapeHtml(d.entity)}</span>` : ''}
          ${d.deadlines?.length ? `<span class="tag">📅 ${d.deadlines.length}</span>` : ''}
          ${d.protected ? '<span class="tag">🔒</span>' : ''}
          ${d.drive ? '<span class="tag">☁️ Drive</span>' : ''}
        </div>
      </div>`;
    el.addEventListener('click', () => openDoc(d));
    wrap.appendChild(el);
  }
}

function renderDue() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const items = [];
  for (const d of libCache) {
    for (const dl of d.deadlines || []) {
      const dt = parseVnDate(dl.date);
      if (!dt) continue;
      const days = Math.round((dt - now) / 86400000);
      if (days >= -30 && days <= 60) items.push({ d, dl, days });
    }
  }
  items.sort((a, b) => a.days - b.days);
  $('#dueBox').hidden = !items.length;
  $('#dueList').innerHTML = '';
  for (const it of items.slice(0, 8)) {
    const el = document.createElement('div');
    el.className = 'due-item';
    const when = it.days < 0 ? `Quá hạn ${-it.days} ngày` : it.days === 0 ? 'Hôm nay' : `Còn ${it.days} ngày`;
    el.innerHTML = `<span><b>${escapeHtml(it.dl.label)}</b> · ${escapeHtml(it.d.title || it.d.name)}<br><small>${escapeHtml(it.dl.date)}${it.d.entity ? ' · ' + escapeHtml(it.d.entity) : ''}</small></span>
      <span class="when ${it.days < 0 ? 'late' : it.days <= 7 ? 'soon' : ''}">${when}</span>`;
    el.addEventListener('click', () => openDoc(it.d));
    $('#dueList').appendChild(el);
  }
}

$('#btnExportXlsx').addEventListener('click', async () => {
  const list = filteredDocs();
  if (!list.length) return toast('Không có tài liệu để xuất');
  try {
    await loadScript(LIBS.xlsx);
    const XLSX = window.XLSX;
    const labels = [];
    list.forEach((d) => (d.fields || []).forEach((f) => f.label && !labels.includes(f.label) && labels.push(f.label)));
    const rows = list.map((d) => {
      const row = {
        'Tên file': d.name,
        'Loại': d.docType,
        'Đơn vị': d.entity || '',
        'Ngày tài liệu': d.date || '',
        'Tiêu đề': d.title || '',
        'Tóm tắt': d.summary || '',
        'Mốc thời gian': (d.deadlines || []).map((x) => `${x.label}: ${x.date}`).join('; '),
        'Số trang': d.pages,
        'Ngày quét': new Date(d.createdAt).toLocaleString('vi-VN'),
        'Link Drive': d.drive?.webViewLink || '',
      };
      for (const l of labels) row[l] = (d.fields || []).filter((f) => f.label === l).map((f) => f.value).join('; ');
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(50, Math.max(10, k.length + 2)) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Tài liệu');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await saveToDevice(blob, `Danh-sach-tai-lieu_${toIsoDate()}.xlsx`);
  } catch (err) {
    toast('Lỗi xuất Excel: ' + err.message, 5000);
  }
});

// ------------------------------------------------------------------ Chi tiết tài liệu + hỏi đáp AI
const dlg = { doc: null, history: [] };

function openDoc(d) {
  dlg.doc = d;
  dlg.history = [];
  $('#dlgTitle').textContent = d.docType;
  $('#dlgThumb').src = d.thumb;
  $('#dlgName').value = d.name;
  $('#dlgType').value = DOC_TYPES.includes(d.docType) ? d.docType : 'Khác';
  $('#dlgEntity').value = d.entity || '';
  $('#dlgDate').value = d.date || '';
  $('#dlgTags').value = (d.tags || []).join(', ');
  $('#dlgDocTitle').value = d.title || '';
  $('#dlgSummary').value = d.summary || '';
  $('#dlgText').value = d.text || '';
  $('#dlgFields').innerHTML = '';
  (d.fields || []).forEach((f) => addRow('#dlgFields', f.label, f.value, 'Nhãn', 'Giá trị'));
  $('#dlgDeadlines').innerHTML = '';
  (d.deadlines || []).forEach((x) => addRow('#dlgDeadlines', x.label, x.date, 'Việc cần nhớ', 'dd/mm/yyyy'));
  $('#chatLog').innerHTML = '';
  $('#docDlg').querySelector('[data-a="drive"]').textContent = d.drive ? '☁️ Xem trên Drive' : '☁️ Lên Drive';
  $('#docDlg').showModal();
  $('#docDlg .dlg-body').scrollTop = 0;
}

function readDocForm() {
  const d = dlg.doc;
  let name = $('#dlgName').value.trim() || d.name;
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  Object.assign(d, {
    name,
    docType: $('#dlgType').value,
    entity: $('#dlgEntity').value.trim(),
    date: $('#dlgDate').value.trim(),
    tags: $('#dlgTags').value.split(',').map((t) => t.trim()).filter(Boolean),
    title: $('#dlgDocTitle').value.trim(),
    summary: $('#dlgSummary').value.trim(),
    text: $('#dlgText').value,
    fields: readRows('#dlgFields'),
    deadlines: readRows('#dlgDeadlines').map((r) => ({ label: r.label, date: r.value })),
  });
  return d;
}

$('#dlgClose').addEventListener('click', () => $('#docDlg').close());
$('#dlgSave').addEventListener('click', async () => {
  await db.put(readDocForm());
  toast('Đã lưu thay đổi');
  $('#docDlg').close();
  renderLibrary();
});
$('#dlgAddField').addEventListener('click', () => addRow('#dlgFields', '', '', 'Nhãn', 'Giá trị'));
$('#dlgAddDeadline').addEventListener('click', () => addRow('#dlgDeadlines', '', '', 'Việc cần nhớ', 'dd/mm/yyyy'));

$('#docDlg .dlg-acts').addEventListener('click', async (e) => {
  const a = e.target.closest('button')?.dataset.a;
  const d = dlg.doc;
  if (!a || !d) return;
  if (a === 'open') window.open(URL.createObjectURL(d.pdf), '_blank');
  if (a === 'share') await saveToDevice(d.pdf, d.name);
  if (a === 'ics') exportIcs(readDocForm());
  if (a === 'del' && confirm(`Xóa "${d.name}" khỏi thư viện?\n(File trên Google Drive, nếu có, vẫn được giữ.)`)) {
    await db.del(d.id);
    $('#docDlg').close();
    renderLibrary();
  }
  if (a === 'drive') {
    if (d.drive) return window.open(d.drive.webViewLink, '_blank');
    try {
      toast('Đang tải lên Drive…', 10000);
      readDocForm();
      d.drive = await uploadToDrive({
        clientId: settings.clientId,
        rootFolder: settings.folder,
        path: drivePath(settings.driveStructure, d),
        pdfBlob: d.pdf,
        pdfName: d.name,
        description: [d.title, d.summary, ...(d.fields || []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join('\n'),
        props: { loai: d.docType, ngay: d.date, donvi: d.entity },
      });
      await db.put(d);
      toast('Đã tải lên Google Drive');
      e.target.textContent = '☁️ Xem trên Drive';
    } catch (err) {
      toast(err.message, 5000);
    }
  }
});

function chatBubble(cls, text) {
  const b = document.createElement('div');
  b.className = cls;
  b.textContent = text;
  $('#chatLog').appendChild(b);
  b.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return b;
}

async function ask(question) {
  question = question.trim();
  if (!question || !dlg.doc) return;
  $('#chatInput').value = '';
  chatBubble('msg-q', question);
  const wait = chatBubble('msg-a wait', 'Đang suy nghĩ…');
  $('#chatSend').disabled = true;
  try {
    const answer = await askDocument({ apiKey: settings.apiKey, model: settings.model, doc: readDocForm(), question, history: dlg.history });
    dlg.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    wait.className = 'msg-a';
    wait.textContent = answer;
  } catch (err) {
    wait.className = 'msg-a';
    wait.textContent = '❌ ' + err.message;
  } finally {
    $('#chatSend').disabled = false;
  }
}
$('#chatSend').addEventListener('click', () => ask($('#chatInput').value));
$('#chatInput').addEventListener('keydown', (e) => e.key === 'Enter' && ask(e.target.value));
$$('#docDlg .quick .chip-btn').forEach((b) => b.addEventListener('click', () => ask(b.textContent)));

// ------------------------------------------------------------------ Cài đặt
function fillSettings() {
  $('#setApiKey').value = settings.apiKey;
  $('#setModel').value = settings.model;
  $('#setAutoAi').checked = settings.autoAi;
  $('#setEntities').value = settings.entities;
  $('#setClientId').value = settings.clientId;
  $('#setFolder').value = settings.folder;
  $('#setDriveStructure').value = settings.driveStructure;
  $('#setOcrLang').value = settings.ocrLang;
  $('#setFilter').value = settings.filter;
  $('#setAutoCrop').checked = settings.autoCrop;
  $('#setAutoShot').checked = settings.autoShot;
}
fillSettings();

function readSettings() {
  settings = {
    apiKey: $('#setApiKey').value.trim(),
    model: $('#setModel').value,
    autoAi: $('#setAutoAi').checked,
    entities: $('#setEntities').value.trim(),
    clientId: $('#setClientId').value.trim(),
    folder: $('#setFolder').value.trim() || 'PDF Scanner',
    driveStructure: $('#setDriveStructure').value,
    ocrLang: $('#setOcrLang').value,
    filter: $('#setFilter').value,
    autoCrop: $('#setAutoCrop').checked,
    autoShot: $('#setAutoShot').checked,
  };
  storeSettings();
  fillEntityList();
}
$('#btnSaveSettings').addEventListener('click', () => {
  readSettings();
  toast('Đã lưu cài đặt');
});

async function showStorageInfo() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) $('#storageInfo').textContent = `Bộ nhớ app đang dùng: ${fmtSize(est.usage || 0)} / còn trống khoảng ${fmtSize((est.quota || 0) - (est.usage || 0))}`;
  } catch {}
}

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
} else {
  checkDraft();
}

renderPages();

// Dùng cho kiểm thử tự động
window.__pdfScanner = { state, importFiles, getProcessed };
