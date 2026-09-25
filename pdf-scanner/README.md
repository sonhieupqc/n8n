# 📄 PDF Scanner AI

Ứng dụng quét tài liệu thành PDF chạy trên điện thoại (Android/iPhone) và máy tính, dạng **PWA**: mở bằng trình duyệt rồi bấm **"Thêm vào màn hình chính"** là dùng như app thật, không cần qua App Store / CH Play.

## Tính năng

| Bước | Chức năng |
|---|---|
| **1. Nguồn đầu vào** | Camera trực tiếp (tự khoanh vùng tờ giấy khi ngắm, chụp liên tục nhiều trang) · Chụp nhanh bằng app camera của máy · Ảnh từ thư viện (chọn nhiều) · File **PDF** · File **Word (.docx)** · File **Excel (.xlsx, .xls, .csv, .ods)** · File văn bản · Kéo-thả / dán ảnh (trên máy tính) · Nhận file qua menu **Chia sẻ** của Android |
| **2. Chuẩn hóa** | Tự dò mép giấy và **cắt + nắn phẳng phối cảnh** (ảnh chụp nghiêng thành thẳng) · Chỉnh 4 góc bằng tay có kính lúp · Xoay · Bộ lọc **Làm nét + tăng tương phản / Thang xám / Đen trắng (tài liệu)** · Sắp xếp, xóa trang · Gộp mọi nguồn thành 1 PDF (A4, Letter hoặc theo ảnh; 3 mức dung lượng) |
| **3. AI đọc & hiểu** | **OCR trên máy** (Tesseract, tiếng Việt + Anh, miễn phí, chạy được offline) hoặc **AI Claude** (đọc cả chữ viết tay, bảng biểu) · **Phân loại** tự động: Hóa đơn, Biên lai, Hợp đồng, Giấy tờ tùy thân, Nhà đất, Ngân hàng, Công văn, Báo giá, Học tập, Visa/di trú, Y tế… · **Trích xuất**: số hóa đơn, ký hiệu, MST, ngày, tổng tiền, điện thoại, email, số tài khoản, các bên… (sửa được) · Tóm tắt + đặt tên file tự động · File Word/Excel/PDF có chữ sẵn thì dùng chữ gốc, không cần OCR |
| **4. Lưu** | **Thư viện trong app** (tìm theo nội dung, số hóa đơn, lọc theo loại) · **Lưu vào điện thoại** (bảng chia sẻ → "Lưu vào Tệp", Zalo, Email…) · **Google Drive**, tự tạo thư mục `PDF Scanner/<Loại tài liệu>/`, kèm tóm tắt trong mô tả file · Tùy chọn kèm file `.json` chứa toàn văn + các trường trích xuất |

## Cách chạy

App là các file tĩnh (HTML/JS/CSS), không cần máy chủ riêng. Camera và Google Drive **bắt buộc chạy qua HTTPS**, nên anh đưa thư mục `pdf-scanner/` lên một trong các nơi sau:

- **Netlify Drop** (dễ nhất): vào https://app.netlify.com/drop, kéo thả thư mục `pdf-scanner` là có link `https://…netlify.app`.
- **GitHub Pages**: Settings → Pages → chọn nhánh chứa code, thư mục gốc; mở `https://<user>.github.io/<repo>/pdf-scanner/`.
- **Thử trên máy tính**: `cd pdf-scanner && python3 -m http.server 8080` rồi mở http://localhost:8080.

Trên điện thoại: mở link → menu trình duyệt → **Thêm vào màn hình chính / Cài đặt ứng dụng**.

## Cấu hình AI Claude (tùy chọn)

1. Tạo API key tại https://console.anthropic.com → *API Keys*.
2. Trong app: **Cài đặt → AI Claude** → dán key, chọn model (mặc định Claude Opus 5, chính xác nhất; Sonnet 5 / Haiku 4.5 rẻ hơn).
3. Ở bước 3 bấm **✨ AI Claude**. Mỗi lần gửi tối đa 20 trang.

> Key chỉ lưu trong trình duyệt của máy anh và được gửi thẳng tới Anthropic. Không nên nhập key trên máy dùng chung.

## Cấu hình Google Drive

1. Vào https://console.cloud.google.com → tạo Project (ví dụ *PDF Scanner*).
2. **APIs & Services → Library** → bật **Google Drive API**.
3. **OAuth consent screen**: chọn *External*, điền tên app + email, thêm email của anh vào *Test users*.
4. **Credentials → Create credentials → OAuth client ID** → loại **Web application**
   → ở *Authorized JavaScript origins* thêm địa chỉ app, ví dụ `https://ten-app.netlify.app` (và `http://localhost:8080` nếu thử trên máy).
5. Copy **Client ID** (`…apps.googleusercontent.com`) → dán vào **Cài đặt → Google Drive** trong app → bấm **Đăng nhập Google**.

App chỉ xin quyền `drive.file`: **chỉ thấy và sửa các file do chính app tạo**, không đọc được các file khác trên Drive của anh.

## Cấu trúc mã nguồn

```
pdf-scanner/
├── index.html            Giao diện (3 tab: Quét, Thư viện, Cài đặt)
├── styles.css            Giao diện mobile-first, hỗ trợ chế độ tối
├── app.js                Điều khiển luồng 4 bước, camera, trình chỉnh trang, thư viện
├── imaging.js            Dò mép giấy (Otsu + vùng liên thông), nắn phối cảnh (homography), bộ lọc
├── converters.js         PDF (pdf.js), Word (mammoth), Excel (SheetJS) → trang ảnh + chữ gốc
├── ai.js                 OCR (Tesseract.js), phân loại/trích xuất theo luật, Claude (Anthropic SDK)
├── storage.js            IndexedDB, chia sẻ/tải về, Google Drive API
├── sw.js                 Service worker: chạy offline, nhận file chia sẻ
├── manifest.webmanifest  Thông tin cài đặt PWA
└── icon.svg
```

Thư viện bên ngoài được tải từ `cdn.jsdelivr.net` khi cần lần đầu và lưu đệm để dùng offline.

## Giới hạn hiện tại

- File `.doc` / `.xls` đời rất cũ: `.xls` đọc được; `.doc` cần mở bằng Word và lưu lại thành `.docx`.
- Word/Excel được dựng lại để chuyển PDF, bố cục phức tạp (text box, biểu đồ) có thể khác bản gốc.
- PDF xuất ra là ảnh; toàn văn OCR được lưu kèm trong Thư viện, trong mô tả file trên Drive và trong file `.json`.
