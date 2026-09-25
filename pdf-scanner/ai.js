// AI đọc & hiểu: OCR trên máy (Tesseract), phân loại + trích xuất bằng luật,
// hoặc dùng Claude (đọc ảnh trực tiếp, phân loại và trích xuất có cấu trúc).

import { LIBS, loadScript } from './converters.js';
import { scaleCanvas } from './imaging.js';

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
  'Thư từ',
  'Khác',
];

// ------------------------------------------------------------------ OCR trên máy
let worker = null;
let workerLang = '';
const ocrState = { i: 0, n: 1, cb: null };

export async function ocrPages(canvases, lang, onProgress) {
  await loadScript(LIBS.tesseract);
  ocrState.cb = onProgress;
  ocrState.n = canvases.length;
  ocrState.i = 0;
  if (!worker || workerLang !== lang) {
    if (worker) await worker.terminate();
    onProgress?.(0, 'Đang tải bộ nhận dạng chữ…');
    worker = await window.Tesseract.createWorker(lang, 1, {
      logger: (m) => {
        const { i, n, cb } = ocrState;
        if (m.status === 'recognizing text') cb?.((i + m.progress) / n, `Đang đọc chữ trang ${i + 1}/${n}`);
        else if (m.progress != null) cb?.(0, `${m.status} ${Math.round(m.progress * 100)}%`);
      },
    });
    workerLang = lang;
  }
  const texts = [];
  for (let i = 0; i < canvases.length; i++) {
    ocrState.i = i;
    onProgress?.(i / canvases.length, `Đang đọc chữ trang ${i + 1}/${canvases.length}`);
    const { data } = await worker.recognize(canvases[i]);
    texts.push(data.text.trim());
  }
  onProgress?.(1, 'Xong');
  return texts;
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

export function localAnalyze(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 3);
  const type = classifyText(text);
  const fields = extractFields(text);
  const title = (lines.find((l) => l === l.toUpperCase() && /[A-ZÀ-Ỹ]/.test(l) && l.length < 80) || lines[0] || type).slice(0, 80);
  const date = fields.find((f) => f.label === 'Ngày')?.value || '';
  return {
    doc_type: type,
    title,
    date,
    summary: lines.slice(0, 3).join(' ').slice(0, 240),
    fields,
    full_text: text,
    tags: [],
  };
}

// ------------------------------------------------------------------ Claude
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'title', 'date', 'summary', 'fields', 'full_text', 'suggested_filename', 'tags'],
  properties: {
    doc_type: { type: 'string', enum: DOC_TYPES },
    title: { type: 'string', description: 'Tiêu đề ngắn gọn của tài liệu' },
    date: { type: 'string', description: 'Ngày của tài liệu dạng dd/mm/yyyy, rỗng nếu không có' },
    summary: { type: 'string', description: 'Tóm tắt 1-3 câu bằng tiếng Việt' },
    fields: {
      type: 'array',
      description: 'Các thông tin quan trọng: số chứng từ, bên liên quan, MST, số tiền, hạn, số tài khoản…',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'value'],
        properties: { label: { type: 'string' }, value: { type: 'string' } },
      },
    },
    full_text: { type: 'string', description: 'Toàn bộ nội dung chữ trên tài liệu, giữ xuống dòng' },
    suggested_filename: { type: 'string', description: 'Tên file không dấu, dạng Loai_YYYY-MM-DD_NoiDung' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};

const PROMPT = `Bạn là trợ lý số hóa tài liệu cho một gia đình kinh doanh ở Việt Nam.
Các ảnh đính kèm là các trang của MỘT tài liệu (thứ tự như gửi). Hãy:
1. Đọc chính xác toàn bộ chữ (OCR), kể cả bảng biểu và chữ viết tay; giữ nguyên dấu tiếng Việt.
2. Phân loại tài liệu vào một trong các loại cho sẵn.
3. Trích xuất các thông tin quan trọng thành cặp nhãn/giá trị bằng tiếng Việt (ví dụ: Số hóa đơn, Đơn vị bán, MST, Tổng tiền, Ngày, Bên A, Bên B, Thời hạn, Số tài khoản…).
4. Viết tóm tắt ngắn gọn và đề xuất tên file.
Nếu có phần chữ trích sẵn từ file gốc bên dưới, dùng nó để kiểm tra lại kết quả đọc.`;

let sdkPromise = null;
async function getClient(apiKey) {
  sdkPromise ??= import(LIBS.anthropic);
  const mod = await sdkPromise;
  const Anthropic = mod.default ?? mod.Anthropic;
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

async function canvasToBase64(canvas) {
  const small = scaleCanvas(canvas, 1568);
  const url = small.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}

export async function claudeAnalyze({ apiKey, model, canvases, nativeText, onProgress }) {
  if (!apiKey) throw new Error('Chưa nhập Anthropic API key trong phần Cài đặt.');
  onProgress?.(0.05, 'Đang chuẩn bị ảnh…');
  const pages = canvases.slice(0, 20);
  const content = [];
  for (let i = 0; i < pages.length; i++) {
    content.push({ type: 'text', text: `Trang ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await canvasToBase64(pages[i]) } });
  }
  let text = PROMPT;
  if (canvases.length > pages.length) text += `\n(Tài liệu có ${canvases.length} trang, chỉ gửi ${pages.length} trang đầu.)`;
  if (nativeText) text += `\n\nChữ trích sẵn từ file gốc:\n"""\n${nativeText.slice(0, 60000)}\n"""`;
  content.push({ type: 'text', text });

  onProgress?.(0.2, 'Claude đang đọc tài liệu…');
  const client = await getClient(apiKey);
  const params = {
    model,
    max_tokens: 32000,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  };
  if (model !== 'claude-haiku-4-5') params.output_config.effort = 'low';

  let message;
  if (model === 'claude-opus-5') {
    // Tự chuyển sang model dự phòng nếu yêu cầu bị từ chối bởi bộ lọc an toàn.
    const stream = client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    message = await stream.finalMessage();
  } else {
    message = await client.messages.stream(params).finalMessage();
  }

  if (message.stop_reason === 'refusal') throw new Error('Claude từ chối xử lý tài liệu này.');
  if (message.stop_reason === 'max_tokens') throw new Error('Tài liệu quá dài – hãy chia nhỏ số trang.');
  const out = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  onProgress?.(1, 'Xong');
  return JSON.parse(out);
}
