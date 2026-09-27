// Google Gemini (gói miễn phí của Google AI Studio): đọc ảnh, phân loại, trích xuất, hỏi đáp.
// Gọi thẳng REST API từ trình duyệt bằng API key của người dùng.

import { PROMPT, buildSchema, toBase64Jpeg } from './ai.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const FALLBACK_MODEL = 'gemini-2.5-flash';

class GeminiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(key, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GeminiError(0, 'NETWORK', 'network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GeminiError(res.status, data.error?.status || '', data.error?.message || res.statusText);
  return data;
}

/** Tự chọn model "flash" mới nhất mà key dùng được (tên model của Google thay đổi theo thời gian). */
export async function resolveGeminiModel(key, preferred) {
  if (preferred) return preferred;
  try {
    const data = await call(key, 'models?pageSize=200');
    const ver = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const list = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|audio|live|thinking|exp|preview|\d{3,}$/.test(n));
    list.sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    return list[0] || FALLBACK_MODEL;
  } catch (err) {
    if (err instanceof GeminiError && (err.status === 400 || err.status === 403)) throw err;
    return FALLBACK_MODEL;
  }
}

/** JSON Schema (dạng dùng cho Claude) → schema OpenAPI rút gọn mà Gemini chấp nhận. */
function toGeminiSchema(s) {
  const out = {};
  if (s.type) out.type = s.type.toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum.filter((v) => v !== '');
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (out.enum && !out.enum.length) delete out.enum;
  return out;
}

function textOf(data) {
  const c = data.candidates?.[0];
  if (!c) {
    const r = data.promptFeedback?.blockReason;
    throw new GeminiError(200, 'BLOCKED', r ? 'blocked:' + r : 'empty');
  }
  if (c.finishReason === 'MAX_TOKENS') throw new GeminiError(200, 'MAX_TOKENS', 'max_tokens');
  if (c.finishReason === 'SAFETY' || c.finishReason === 'PROHIBITED_CONTENT') throw new GeminiError(200, 'BLOCKED', 'blocked');
  return (c.content?.parts || []).map((p) => p.text || '').join('');
}

export async function geminiAnalyze({ key, model, images, nativeText, entities = [], onProgress }) {
  if (!key) throw new GeminiError(0, 'NO_KEY', 'no key');
  onProgress?.(0.05, 'Đang chuẩn bị ảnh…');
  const pages = images.slice(0, 20);
  const parts = [];
  for (let i = 0; i < pages.length; i++) {
    parts.push({ text: `Trang ${i + 1}:` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: await toBase64Jpeg(pages[i]) } });
    onProgress?.(0.05 + (0.15 * (i + 1)) / pages.length, 'Đang chuẩn bị ảnh…');
  }
  const names = entities.map((e) => e.name);
  let text = PROMPT;
  if (names.length) text += `\n\nDanh sách đơn vị/chủ sở hữu: ${names.join('; ')}. Nếu không thuộc đơn vị nào, để entity rỗng.`;
  text += `\nHôm nay là ${new Date().toLocaleDateString('vi-VN')}.`;
  if (images.length > pages.length) text += `\n(Tài liệu có ${images.length} trang, chỉ gửi ${pages.length} trang đầu.)`;
  if (nativeText) text += `\n\nChữ đọc sẵn (OCR/file gốc) để đối chiếu:\n"""\n${nativeText.slice(0, 60000)}\n"""`;
  parts.push({ text });

  onProgress?.(0.25, 'Gemini đang đọc và phân tích tài liệu…');
  const m = await resolveGeminiModel(key, model);
  const data = await call(key, `models/${m}:generateContent`, {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(buildSchema(names)),
      temperature: 0.1,
      maxOutputTokens: 32000,
    },
  });
  const out = JSON.parse(textOf(data));
  if (out.entity && names.length && !names.includes(out.entity)) out.entity = '';
  onProgress?.(1, 'Xong');
  return out;
}

export async function geminiAsk({ key, model, context, question, history = [] }) {
  if (!key) throw new GeminiError(0, 'NO_KEY', 'no key');
  const m = await resolveGeminiModel(key, model);
  const contents = [
    { role: 'user', parts: [{ text: `<tai_lieu>\n${context}\n</tai_lieu>\n\nHãy trả lời các câu hỏi của tôi về tài liệu này.` }] },
    { role: 'model', parts: [{ text: 'Tôi đã đọc tài liệu. Anh/chị muốn hỏi gì?' }] },
    ...history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: question }] },
  ];
  const data = await call(key, `models/${m}:generateContent`, {
    systemInstruction: {
      parts: [
        {
          text:
            'Bạn là trợ lý tài liệu. Trả lời bằng tiếng Việt, ngắn gọn, chính xác, chỉ dựa trên nội dung tài liệu. ' +
            'Nếu tài liệu không có thông tin, nói rõ là không có. Khi được yêu cầu dịch hoặc soạn thảo, làm đầy đủ. Không dùng định dạng Markdown.',
        },
      ],
    },
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: 8000 },
  });
  return textOf(data);
}

const AISTUDIO = '<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>';

export function describeGeminiError(err) {
  if (!(err instanceof GeminiError)) return { message: err?.message || String(err), fallback: true };
  const msg = err.message || '';
  if (err.code === 'NO_KEY') return { message: 'Chưa nhập Gemini API key.', help: `Lấy key miễn phí tại ${AISTUDIO} rồi dán vào Cài đặt.`, fallback: true };
  if (err.code === 'NETWORK') return { message: navigator.onLine ? 'Không kết nối được tới Google Gemini.' : 'Không có mạng – Gemini cần Internet.', fallback: true };
  if (err.status === 429 || err.code === 'RESOURCE_EXHAUSTED')
    return { message: 'Đã dùng hết lượt Gemini miễn phí (theo phút hoặc theo ngày).', help: 'Đợi một lúc hoặc sang ngày mai sẽ dùng tiếp được. Trong lúc chờ, app đọc bằng OCR trên máy.', fallback: true };
  if (/API key not valid|API_KEY_INVALID/i.test(msg) || (err.status === 400 && /key/i.test(msg)))
    return { message: 'Gemini API key không đúng.', help: `Tạo lại key tại ${AISTUDIO} rồi dán vào Cài đặt.`, fallback: true };
  if (err.status === 403) return { message: 'Key Gemini chưa được phép dùng (có thể do khu vực hoặc chưa bật API).', help: `Kiểm tra lại tại ${AISTUDIO}.`, fallback: true };
  if (err.status === 404) return { message: 'Model Gemini đã chọn không còn tồn tại.', help: 'Vào Cài đặt, để trống ô Model để app tự chọn.', fallback: true };
  if (err.status >= 500) return { message: 'Máy chủ Gemini đang quá tải.', help: 'Thử lại sau ít phút.', fallback: true };
  if (err.code === 'BLOCKED') return { message: 'Gemini từ chối xử lý tài liệu này.', fallback: true };
  if (err.code === 'MAX_TOKENS') return { message: 'Tài liệu quá dài cho Gemini – hãy chia nhỏ số trang.', fallback: true };
  return { message: 'Lỗi Gemini: ' + msg.slice(0, 200), fallback: true };
}
