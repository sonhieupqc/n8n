// AI đọc & hiểu tài liệu:
//  - OCR trên máy (Tesseract.js) kèm tọa độ từng chữ để tạo PDF tìm kiếm được
//  - Phân loại, trích xuất, tìm hạn & nhận diện đơn vị bằng luật (offline)
//  - Claude: đọc ảnh trực tiếp, trả về dữ liệu có cấu trúc; hỏi đáp với tài liệu

import { LIBS, loadScript } from './converters.js';
import { scaleCanvas, blobToCanvas } from './imaging.js';

export const DOC_TYPES = [
  'Hóa đơn',
  'Biên lai / Phiếu thu chi',
  'Hợp đồng',
  'Giấy tờ tùy thân',
  'Giấy tờ nhà đất',
  'Sao kê / Chứng từ ngân hàng',
  'Công văn / Quyết định',
  'Báo giá / Đơn hàng',
  'Bảng tính / Báo cáo',
  'Hồ sơ học tập',
  'Hồ sơ visa / di trú',
  'Y tế',
  'Bảo hiểm',
  'Thư từ',
  'Khác',
];

/** Bỏ dấu tiếng Việt, chữ thường – dùng để so khớp không phân biệt dấu. */
export function fold(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

// ------------------------------------------------------------------ OCR trên máy
let worker = null;
let workerLang = '';
const ocrState = { i: 0, n: 1, cb: null };

async function getWorker(lang, onProgress) {
  await loadScript(LIBS.tesseract);
  if (!worker || workerLang !== lang) {
    if (worker) await worker.terminate();
    onProgress?.(0, 'Đang tải bộ nhận dạng chữ (lần đầu ~15MB)…');
    worker = await window.Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        const { i, n, cb } = ocrState;
        if (m.status === 'recognizing text') cb?.((i + m.progress) / n, `Đang đọc chữ trang ${i + 1}/${n}`);
        else if (m.progress != null) cb?.(0, `Chuẩn bị OCR: ${Math.round(m.progress * 100)}%`);
      },
    });
    workerLang = lang;
  }
  return worker;
}

/**
 * OCR danh sách ảnh (Blob hoặc canvas). Trả về cho mỗi trang:
 * { text, width, height, words: [{ text, x0, y0, x1, y1 }] }
 */
export async function ocrImages(images, lang, onProgress) {
  const w = await getWorker(lang, onProgress);
  ocrState.cb = onProgress;
  ocrState.n = images.length;
  const out = [];
  for (let i = 0; i < images.length; i++) {
    ocrState.i = i;
    onProgress?.(i / images.length, `Đang đọc chữ trang ${i + 1}/${images.length}`);
    const img = images[i] instanceof Blob ? await blobToCanvas(images[i]) : images[i];
    const { data } = await w.recognize(img, {}, { text: true, blocks: true });
    const words = [];
    for (const b of data.blocks || [])
      for (const p of b.paragraphs || [])
        for (const l of p.lines || [])
          for (const wd of l.words || [])
            if (wd.text.trim() && wd.confidence > 20) words.push({ text: wd.text, ...wd.bbox });
    out.push({ text: (data.text || '').trim(), width: img.width, height: img.height, words });
  }
  onProgress?.(1, 'Xong');
  return out;
}

// ------------------------------------------------------------------ Phân loại & trích xuất bằng luật
const RULES = [
  ['Hóa đơn', /h[oó]a\s*[đd][oơ]n|invoice|gtgt|vat|m[ãa]\s*s[oố]\s*thu[eế]|k[ýy]\s*hi[eệ]u/i],
  ['Biên lai / Phiếu thu chi', /bi[eê]n\s*lai|phi[eế]u\s*(thu|chi)|receipt|[đd][ãa]\s*thanh\s*to[aá]n/i],
  ['Hợp đồng', /h[oợ]p\s*[đd][oồ]ng|contract|agreement|b[eê]n\s*a\b|b[eê]n\s*b\b|[đd]i[eề]u\s*\d+/i],
  ['Giấy tờ tùy thân', /c[aă]n\s*c[uư][oớ]c|cccd|cmnd|passport|h[oộ]\s*chi[eế]u|gi[aấ]y\s*ph[eé]p\s*l[aá]i\s*xe|identity\s*card/i],
  ['Giấy tờ nhà đất', /quy[eề]n\s*s[uử]\s*d[uụ]ng\s*[đd][aấ]t|s[oổ]\s*([đd][oỏ]|h[oồ]ng)|th[uử]a\s*[đd][aấ]t|t[aà]i\s*s[aả]n\s*g[aắ]n\s*li[eề]n/i],
  ['Sao kê / Chứng từ ngân hàng', /sao\s*k[eê]|statement|s[oố]\s*t[aà]i\s*kho[aả]n|ng[aâ]n\s*h[aà]ng|chuy[eể]n\s*kho[aả]n|bank/i],
  ['Công văn / Quyết định', /c[oộ]ng\s*h[oò]a\s*x[aã]\s*h[oộ]i|quy[eế]t\s*[đd][iị]nh|c[oô]ng\s*v[aă]n|th[oô]ng\s*b[aá]o|k[íi]nh\s*g[uử]i/i],
  ['Báo giá / Đơn hàng', /b[aá]o\s*gi[aá]|quotation|[đd][oơ]n\s*([đd][aặ]t\s*)?h[aà]ng|purchase\s*order/i],
  ['Hồ sơ học tập', /transcript|university|b[aả]ng\s*[đd]i[eể]m|tr[uư][oờ]ng|sinh\s*vi[eê]n|student|gpa|diploma|b[aằ]ng\s*t[oố]t\s*nghi[eệ]p/i],
  ['Hồ sơ visa / di trú', /visa|uscis|i-20|ds-160|eb-3|perm|immigration|green\s*card|sevis|priority\s*date/i],
  ['Y tế', /b[eệ]nh\s*vi[eệ]n|[đd][oơ]n\s*thu[oố]c|ch[aẩ]n\s*[đd]o[aá]n|x[eé]t\s*nghi[eệ]m|hospital|prescription/i],
  ['Thư từ', /th[aâ]n\s*g[uử]i|k[íi]nh\s*th[uư]|dear\s|sincerely/i],
];

export function classifyText(text) {
  let best = 'Khác';
  let bestScore = 0;
  for (const [type, re] of RULES) {
    const g = new RegExp(re.source, 'gi');
    const score = (text.match(g) || []).length;
    if (score > bestScore) {
      bestScore = score;
      best = type;
    }
  }
  return best;
}

export function extractFields(text) {
  const fields = [];
  const add = (label, value) => {
    value = String(value || '').trim();
    if (value && !fields.some((f) => f.label === label && f.value === value)) fields.push({ label, value });
  };
  const dates = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g) || [];
  const dateVn = text.match(/ng[aà]y\s*(\d{1,2})\s*th[aá]ng\s*(\d{1,2})\s*n[aă]m\s*(\d{4})/i);
  if (dateVn) add('Ngày', `${dateVn[1].padStart(2, '0')}/${dateVn[2].padStart(2, '0')}/${dateVn[3]}`);
  dates.slice(0, 3).forEach((d) => add('Ngày', d));
  const mst = text.match(/m[aã]\s*s[oố]\s*thu[eế][^\d]{0,10}([\d\s\-]{10,16})/i);
  if (mst) add('Mã số thuế', mst[1].replace(/\s/g, ''));
  const inv = text.match(/(?:s[oố]\s*h[oó]a\s*[đd][oơ]n|s[oố]\s*ch[uứ]ng\s*t[uừ]|s[oố]\s*phi[eế]u|invoice\s*(?:no|#)|\bno\.)\s*[:#]?\s*([A-Z0-9\-\/]*\d[A-Z0-9\-\/]*)/i);
  if (inv) add('Số chứng từ', inv[1]);
  const kyhieu = text.match(/k[ýy]\s*hi[eệ]u[^\w]{0,5}([A-Z0-9\/\-]{3,15})/i);
  if (kyhieu) add('Ký hiệu', kyhieu[1]);
  const total = text.match(/(?:t[oổ]ng\s*(?:c[oộ]ng)?\s*(?:ti[eề]n)?\s*(?:thanh\s*to[aá]n)?|total|amount)[^\d]{0,25}([\d.,]{4,})/i);
  if (total) add('Tổng tiền', total[1]);
  (text.match(/\b\d{12}\b/g) || []).slice(0, 1).forEach((v) => add('Số CCCD (có thể)', v));
  const acctNo = (text.match(/(?:s[oố]\s*t[aà]i\s*kho[aả]n|stk|account\s*(?:no|number))[^\d]{0,8}([\d\s]{6,20})/i)?.[1] || '').replace(/\s/g, '');
  (text.match(/(?:\+84|0)(?:[\s.]?\d){9,10}\b/g) || [])
    .map((v) => v.replace(/[\s.]/g, ''))
    .filter((v) => v !== acctNo)
    .slice(0, 3)
    .forEach((v) => add('Điện thoại', v));
  (text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).slice(0, 3).forEach((v) => add('Email', v));
  if (acctNo) add('Số tài khoản', acctNo);
  return fields;
}

// ------------------------------------------------------------------ Hạn, độ nhạy cảm, đơn vị
const DATE_RE = /(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{4})|ng[aà]y\s*(\d{1,2})\s*th[aá]ng\s*(\d{1,2})\s*n[aă]m\s*(\d{4})/i;
const DEADLINE_LABELS = [
  ['Hạn thanh toán', /h[aạ]n\s*(thanh\s*to[aá]n|n[oộ]p|tr[aả])|due\s*date|payment\s*due/i],
  ['Ngày hết hạn', /(ng[aà]y\s*)?h[eế]t\s*h[aạ]n|c[oó]\s*gi[aá]\s*tr[iị]\s*([đd][eế]n|t[oớ]i)|expir\w*|valid\s*(until|thru|through)/i],
  ['Hạn hợp đồng', /th[oờ]i\s*h[aạ]n\s*(thu[eê]|h[oợ]p\s*[đd][oồ]ng)|[đd][eế]n\s*h[eế]t\s*ng[aà]y/i],
  ['Ngày hẹn', /l[iị]ch\s*h[eẹ]n|ng[aà]y\s*h[eẹ]n|appointment|interview/i],
];

function normDate(m) {
  const d = m[1] || m[4];
  const mo = m[2] || m[5];
  const y = m[3] || m[6];
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return '';
  return `${String(d).padStart(2, '0')}/${String(mo).padStart(2, '0')}/${y}`;
}

export function findDeadlines(text) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [label, re] of DEADLINE_LABELS) {
      if (!re.test(line)) continue;
      const scope = line + ' ' + (lines[i + 1] || '');
      const idx = scope.search(re);
      const m = scope.slice(idx).match(DATE_RE);
      if (m) {
        const date = normDate(m);
        if (date && !out.some((x) => x.date === date && x.label === label)) out.push({ label, date });
      }
    }
  });
  return out.slice(0, 6);
}

export function isSensitive(text, type) {
  if (type === 'Giấy tờ tùy thân' || type === 'Sao kê / Chứng từ ngân hàng' || type === 'Y tế') return true;
  return /\b\d{12}\b|passport\s*no|h[oộ]\s*chi[eế]u\s*s[oố]|m[aậ]t\s*kh[aẩ]u|password|\bssn\b|social\s*security/i.test(text);
}

/**
 * Danh sách đơn vị từ cài đặt, mỗi dòng: "Tên | từ khóa 1, từ khóa 2".
 * Trả về [{ name, keywords: [..] }]
 */
export function parseEntities(src) {
  return String(src || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, kw = ''] = l.split('|');
      const keywords = [name, ...kw.split(',')].map((k) => fold(k.trim())).filter((k) => k.length > 2);
      return { name: name.trim(), keywords };
    });
}

export function detectEntity(text, entities) {
  const t = fold(text);
  let best = '';
  let bestN = 0;
  for (const e of entities) {
    let n = 0;
    for (const k of e.keywords) n += t.split(k).length - 1;
    if (n > bestN) {
      bestN = n;
      best = e.name;
    }
  }
  return best;
}

export function localAnalyze(text, entities = []) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 3);
  const type = classifyText(text);
  const fields = extractFields(text);
  const title = (lines.find((l) => l === l.toUpperCase() && /[A-ZÀ-Ỹ]{3}/.test(l) && l.length < 80) || lines[0] || type).slice(0, 80);
  const deadlines = findDeadlines(text);
  // Ngày đã là mốc hạn thì không lặp lại trong danh sách trường
  for (let i = fields.length - 1; i >= 0; i--)
    if (fields[i].label === 'Ngày' && deadlines.some((d) => d.date === fields[i].value)) fields.splice(i, 1);
  const date = fields.find((f) => f.label === 'Ngày' && !deadlines.some((d) => d.date === f.value))?.value || '';
  return {
    doc_type: type,
    entity: detectEntity(text, entities),
    title,
    date,
    summary: lines.slice(0, 3).join(' ').slice(0, 240),
    fields,
    deadlines,
    sensitive: isSensitive(text, type),
    full_text: text,
    tags: [],
  };
}

// ------------------------------------------------------------------ Claude
export function buildSchema(entityNames) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['doc_type', 'entity', 'title', 'date', 'summary', 'fields', 'deadlines', 'sensitive', 'full_text', 'suggested_filename', 'tags'],
    properties: {
      doc_type: { type: 'string', enum: DOC_TYPES },
      entity: entityNames.length
        ? { type: 'string', enum: [...entityNames, ''], description: 'Đơn vị/chủ sở hữu mà tài liệu thuộc về; rỗng nếu không rõ' }
        : { type: 'string', description: 'Tên cá nhân/tổ chức chính mà tài liệu thuộc về' },
      title: { type: 'string', description: 'Tiêu đề ngắn gọn của tài liệu' },
      date: { type: 'string', description: 'Ngày lập/ký tài liệu dạng dd/mm/yyyy, rỗng nếu không có' },
      summary: { type: 'string', description: 'Tóm tắt 1-3 câu bằng tiếng Việt, nêu điều quan trọng nhất' },
      fields: {
        type: 'array',
        description: 'Thông tin quan trọng: số chứng từ, các bên, MST, số tiền, số tài khoản, địa chỉ…',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'value'],
          properties: { label: { type: 'string' }, value: { type: 'string' } },
        },
      },
      deadlines: {
        type: 'array',
        description: 'Các mốc thời gian cần nhắc: hạn thanh toán, ngày hết hạn giấy tờ/visa/hợp đồng, lịch hẹn',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['label', 'date'],
          properties: { label: { type: 'string' }, date: { type: 'string', description: 'dd/mm/yyyy' } },
        },
      },
      sensitive: { type: 'boolean', description: 'true nếu có số giấy tờ tùy thân, tài khoản ngân hàng, thông tin y tế…' },
      full_text: { type: 'string', description: 'Toàn bộ nội dung chữ trên tài liệu, giữ xuống dòng' },
      suggested_filename: { type: 'string', description: 'Tên file không dấu, dạng Loai_YYYY-MM-DD_NoiDung' },
      tags: { type: 'array', items: { type: 'string' }, description: '3-6 từ khóa tiếng Việt để tìm kiếm' },
    },
  };
}

export const PROMPT = `Bạn là trợ lý số hóa và quản lý tài liệu cho một gia đình kinh doanh ở Việt Nam.
Các ảnh đính kèm là các trang của MỘT tài liệu (thứ tự như gửi). Hãy:
1. Đọc chính xác toàn bộ chữ (OCR), kể cả bảng biểu, con dấu và chữ viết tay; giữ nguyên dấu tiếng Việt.
2. Phân loại tài liệu và xác định đơn vị/chủ sở hữu (nếu có danh sách, chọn trong danh sách).
3. Trích xuất các thông tin quan trọng thành cặp nhãn/giá trị bằng tiếng Việt (ví dụ: Số hóa đơn, Đơn vị bán, MST, Tổng tiền, Bên A, Bên B, Giá thuê, Số tài khoản…). Số tiền giữ nguyên định dạng và ghi đơn vị tiền.
4. Liệt kê các mốc thời gian cần nhắc việc (hạn thanh toán, ngày hết hạn, thời hạn hợp đồng, lịch hẹn).
5. Viết tóm tắt ngắn, đề xuất tên file và từ khóa.
Nếu có phần chữ trích sẵn từ file gốc bên dưới, dùng nó để kiểm tra lại kết quả đọc.`;

let sdkPromise = null;
async function getSdk() {
  sdkPromise ??= import(LIBS.anthropic);
  const mod = await sdkPromise;
  return mod.default ?? mod.Anthropic;
}
async function getClient(apiKey) {
  const Anthropic = await getSdk();
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

const BILLING = '<a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">console.anthropic.com → Plans &amp; Billing</a>';
const KEYS = '<a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com → API Keys</a>';

/**
 * Đổi lỗi API thành thông báo tiếng Việt dễ hiểu.
 * fallback = true khi nên tự chuyển sang OCR trên máy.
 */
export async function describeAiError(err) {
  let A = null;
  try {
    A = await getSdk();
  } catch {}
  const raw = String(err?.error?.error?.message || err?.message || err || '');
  if (!A) {
    return navigator.onLine
      ? { message: 'Không tải được thư viện AI Claude.', help: 'Kiểm tra kết nối mạng rồi thử lại.', fallback: true }
      : { message: 'Không có mạng – AI Claude cần Internet.', fallback: true };
  }
  if (A.AuthenticationError && err instanceof A.AuthenticationError)
    return { message: 'API key không đúng hoặc đã bị xóa.', help: `Tạo key mới tại ${KEYS} rồi dán vào Cài đặt.`, fallback: true };
  if (A.PermissionDeniedError && err instanceof A.PermissionDeniedError)
    return { message: 'API key không có quyền dùng model này.', help: 'Vào Cài đặt chọn model khác (ví dụ Claude Sonnet 5).', fallback: true };
  if (A.RateLimitError && err instanceof A.RateLimitError)
    return { message: 'Gửi quá nhiều yêu cầu trong thời gian ngắn.', help: 'Đợi khoảng 1 phút rồi thử lại.', fallback: true };
  if (A.BadRequestError && err instanceof A.BadRequestError) {
    // API chỉ phân biệt lỗi hết tiền qua nội dung thông báo
    if (/credit balance/i.test(raw))
      return {
        message: 'Tài khoản Anthropic API đã hết tiền (credit).',
        help: `Nạp thêm tại ${BILLING}. Lưu ý: gói Claude Pro/Max dùng trên web không bao gồm tiền API.`,
        fallback: true,
      };
    return { message: 'Yêu cầu không hợp lệ: ' + raw.slice(0, 200), fallback: true };
  }
  if (A.InternalServerError && err instanceof A.InternalServerError)
    return { message: 'Máy chủ Claude đang quá tải hoặc gặp sự cố.', help: 'Thử lại sau ít phút.', fallback: true };
  if (A.APIConnectionError && err instanceof A.APIConnectionError)
    return { message: navigator.onLine ? 'Không kết nối được tới Claude.' : 'Không có mạng – AI Claude cần Internet.', fallback: true };
  return { message: raw.slice(0, 300) || 'Lỗi không xác định', fallback: /API key/.test(raw) };
}

export async function toBase64Jpeg(img) {
  const canvas = img instanceof Blob ? await blobToCanvas(img) : img;
  const small = scaleCanvas(canvas, 1568);
  const url = small.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}

async function send(client, model, params) {
  const base = { model, ...params };
  if (model !== 'claude-haiku-4-5') base.output_config = { ...(base.output_config || {}), effort: params.effort || 'low' };
  delete base.effort;
  let message;
  if (model === 'claude-opus-5') {
    // Tự chuyển sang model dự phòng nếu yêu cầu bị bộ lọc an toàn từ chối.
    message = await client.beta.messages
      .stream({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      .finalMessage();
  } else {
    message = await client.messages.stream(base).finalMessage();
  }
  if (message.stop_reason === 'refusal') throw new Error('Claude từ chối xử lý tài liệu này.');
  if (message.stop_reason === 'max_tokens') throw new Error('Tài liệu quá dài – hãy chia nhỏ số trang.');
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export async function claudeAnalyze({ apiKey, model, images, nativeText, entities = [], onProgress }) {
  if (!apiKey) throw new Error('Chưa nhập Anthropic API key trong phần Cài đặt.');
  onProgress?.(0.05, 'Đang chuẩn bị ảnh…');
  const pages = images.slice(0, 20);
  const content = [];
  for (let i = 0; i < pages.length; i++) {
    content.push({ type: 'text', text: `Trang ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await toBase64Jpeg(pages[i]) } });
    onProgress?.(0.05 + (0.15 * (i + 1)) / pages.length, 'Đang chuẩn bị ảnh…');
  }
  let text = PROMPT;
  const names = entities.map((e) => e.name);
  if (names.length) text += `\n\nDanh sách đơn vị/chủ sở hữu: ${names.join('; ')}.`;
  text += `\nHôm nay là ${new Date().toLocaleDateString('vi-VN')}.`;
  if (images.length > pages.length) text += `\n(Tài liệu có ${images.length} trang, chỉ gửi ${pages.length} trang đầu.)`;
  if (nativeText) text += `\n\nChữ trích sẵn từ file gốc:\n"""\n${nativeText.slice(0, 60000)}\n"""`;
  content.push({ type: 'text', text });

  onProgress?.(0.25, 'Claude đang đọc và phân tích tài liệu…');
  const client = await getClient(apiKey);
  const out = await send(client, model, {
    max_tokens: 32000,
    output_config: { format: { type: 'json_schema', schema: buildSchema(names) } },
    messages: [{ role: 'user', content }],
  });
  onProgress?.(1, 'Xong');
  return JSON.parse(out);
}

export function docContext(doc) {
  return [
    `Tên file: ${doc.name}`,
    `Loại: ${doc.docType}${doc.entity ? ` · Đơn vị: ${doc.entity}` : ''}${doc.date ? ` · Ngày: ${doc.date}` : ''}`,
    doc.title && `Tiêu đề: ${doc.title}`,
    doc.summary && `Tóm tắt: ${doc.summary}`,
    ...(doc.fields || []).map((f) => `- ${f.label}: ${f.value}`),
    ...(doc.deadlines || []).map((d) => `- Mốc: ${d.label} ${d.date}`),
    '',
    'Toàn văn:',
    (doc.text || '(chưa có – tài liệu chưa được OCR)').slice(0, 120000),
  ]
    .filter((x) => x !== undefined && x !== false)
    .join('\n');
}

/** Hỏi đáp về một tài liệu đã lưu. history: [{ role, content }] */
export async function askDocument({ apiKey, model, doc, question, history = [] }) {
  if (!apiKey) throw new Error('Chưa nhập Anthropic API key trong phần Cài đặt.');
  const client = await getClient(apiKey);
  const context = docContext(doc);
  const messages = [
    { role: 'user', content: `<tai_lieu>\n${context}\n</tai_lieu>\n\nHãy trả lời các câu hỏi của tôi về tài liệu này.` },
    { role: 'assistant', content: 'Tôi đã đọc tài liệu. Anh/chị muốn hỏi gì?' },
    ...history,
    { role: 'user', content: question },
  ];
  return send(client, model, {
    max_tokens: 8000,
    effort: 'medium',
    system:
      'Bạn là trợ lý tài liệu. Trả lời bằng tiếng Việt, ngắn gọn, chính xác, chỉ dựa trên nội dung tài liệu. ' +
      'Nếu tài liệu không có thông tin, nói rõ là không có. Khi được yêu cầu dịch hoặc soạn thảo, làm đầy đủ.',
    messages,
  });
}
