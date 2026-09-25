// Lưu trữ: Thư viện trong máy (IndexedDB), tải về/chia sẻ, và Google Drive.

// ------------------------------------------------------------------ IndexedDB
const DB_NAME = 'pdf-scanner';
const STORE = 'docs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const r = fn(store);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const db = {
  put: (doc) => tx('readwrite', (s) => s.put(doc)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  del: (id) => tx('readwrite', (s) => s.delete(id)),
  all: async () => {
    const list = (await tx('readonly', (s) => s.getAll())) || [];
    return list.sort((a, b) => b.createdAt - a.createdAt);
  },
};

export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {}
}

// ------------------------------------------------------------------ Điện thoại
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Mở bảng chia sẻ của điện thoại (Lưu vào Tệp, Zalo, Email…); nếu không hỗ trợ thì tải về. */
export async function saveToDevice(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, name);
  return 'downloaded';
}

// ------------------------------------------------------------------ Google Drive
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
let gisPromise = null;
let tokenClient = null;
let token = null; // { access_token, expires_at }

function loadGis() {
  gisPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => {
      gisPromise = null;
      reject(new Error('Không tải được Google Sign-In.'));
    };
    document.head.appendChild(s);
  });
  return gisPromise;
}

export function driveSignedIn() {
  return !!token && token.expires_at > Date.now() + 60000;
}

export async function driveSignIn(clientId, prompt = '') {
  if (!clientId) throw new Error('Chưa nhập Google OAuth Client ID trong phần Cài đặt.');
  if (driveSignedIn()) return token.access_token;
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error('Đăng nhập Google thất bại: ' + resp.error));
        token = { access_token: resp.access_token, expires_at: Date.now() + resp.expires_in * 1000 };
        resolve(token.access_token);
      },
      error_callback: (err) => reject(new Error('Đăng nhập Google bị hủy: ' + (err?.type || ''))),
    });
    tokenClient.requestAccessToken({ prompt });
  });
}

async function gapi(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: 'Bearer ' + token.access_token, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`Google Drive lỗi ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const folderCache = new Map();
async function ensureFolder(name, parentId) {
  const key = (parentId || 'root') + '/' + name;
  if (folderCache.has(key)) return folderCache.get(key);
  const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = [
    `name='${safe}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    `'${parentId || 'root'}' in parents`,
  ].join(' and ');
  const found = await gapi('https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q));
  let id = found.files?.[0]?.id;
  if (!id) {
    const created = await gapi('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: parentId ? [parentId] : undefined,
      }),
    });
    id = created.id;
  }
  folderCache.set(key, id);
  return id;
}

async function uploadFile(blob, name, parentId, description, appProperties) {
  const meta = { name, parents: [parentId], description: (description || '').slice(0, 4000), appProperties };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob, name);
  return gapi('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    body: form,
  });
}

/** Tải PDF (và file dữ liệu tùy chọn) lên Drive: <Thư mục gốc>/<Loại tài liệu>/ */
export async function uploadToDrive({ clientId, rootFolder, useSubfolder, docType, pdfBlob, pdfName, description, jsonBlob, props }) {
  await driveSignIn(clientId);
  let parent = await ensureFolder(rootFolder || 'PDF Scanner');
  if (useSubfolder && docType) parent = await ensureFolder(docType, parent);
  const appProperties = {};
  for (const [k, v] of Object.entries(props || {})) if (v) appProperties[k] = String(v).slice(0, 30); // Drive giới hạn 124 byte cho khóa + giá trị
  const pdf = await uploadFile(pdfBlob, pdfName, parent, description, appProperties);
  if (jsonBlob) await uploadFile(jsonBlob, pdfName.replace(/\.pdf$/i, '.json'), parent, '', appProperties);
  return pdf;
}
