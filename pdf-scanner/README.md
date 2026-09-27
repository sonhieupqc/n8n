# 📄 PDF Scanner AI

Ứng dụng quét tài liệu thành PDF chạy trên điện thoại (Android/iPhone) và máy tính, dạng **PWA**: mở bằng trình duyệt rồi bấm **"Thêm vào màn hình chính"** là dùng như app thật, không cần qua App Store / CH Play.

## Tính năng

| Bước | Chức năng |
|---|---|
| **1. Nguồn đầu vào** | Camera trực tiếp: tự khoanh vùng tờ giấy, **tự chụp khi giữ máy yên**, chụp liên tục nhiều trang, bật đèn flash, **cảnh báo ảnh mờ** · Chụp nhanh bằng app camera · Ảnh thư viện (chọn nhiều) · **PDF** · **Word (.docx)** · **Excel (.xlsx, .xls, .csv, .ods)** · File văn bản · Kéo-thả / dán ảnh · Nhận file qua menu **Chia sẻ** của Android |
| **2. Chuẩn hóa** | Tự dò mép giấy, **cắt + nắn phẳng phối cảnh** · Chỉnh 4 góc có kính lúp, xem trước kết quả · Xoay · Bộ lọc **✨ Tự động (khử bóng tay/bóng điện thoại, nền trắng, giữ màu con dấu)**, Làm nét, Thang xám, Đen trắng · Sắp xếp, xóa trang (có hoàn tác) · **Tự lưu phiên quét dở**: lỡ tắt app hay điện thoại tự đóng trình duyệt vẫn khôi phục được |
| **3. AI đọc & hiểu** | **OCR trên máy** (tiếng Việt + Anh, miễn phí, chạy offline) hoặc **AI Claude** (đọc cả chữ viết tay, bảng biểu, con dấu) · **Phân loại** 15 loại tài liệu · Nhận diện **đơn vị/chủ sở hữu** (công ty, hộ kinh doanh, gia đình… tự khai báo) · **Trích xuất** số hóa đơn, MST, số tiền, các bên, số tài khoản… · Tìm **mốc thời gian cần nhắc** (hạn thanh toán, ngày hết hạn giấy tờ/visa, thời hạn hợp đồng, lịch hẹn) · Cảnh báo **tài liệu nhạy cảm** · Phát hiện **tài liệu trùng** đã lưu · Tùy chọn tự chạy AI ngay sau khi quét |
| **4. Tạo PDF & lưu** | **PDF tìm kiếm & copy chữ được** (lớp chữ OCR tiếng Việt nhúng ẩn dưới ảnh) · **Mật khẩu PDF** · **Dấu chìm** ("BẢN SAO – CHỈ DÙNG ĐỂ NỘP HỒ SƠ"…) · Đánh số trang · Khổ A4/Letter, 3 mức dung lượng · Lưu vào Thư viện, điện thoại (Lưu vào Tệp, Zalo, Email…), **Google Drive** tự sắp thư mục theo *Đơn vị / Loại / Năm* · File `.json` dữ liệu kèm theo |
| **Thư viện thông minh** | Tìm kiếm toàn văn không cần gõ dấu · Lọc theo loại, đơn vị; sắp xếp · Bảng **⏰ Sắp đến hạn** (60 ngày tới, quá hạn tô đỏ) · **Thêm vào lịch điện thoại** (.ics, nhắc trước 7 ngày và 1 ngày) · **💬 Hỏi AI về tài liệu**: tóm tắt, dịch sang tiếng Anh, tìm điều khoản bất lợi, liệt kê khoản tiền, soạn email · Sửa thông tin sau khi lưu · **Xuất Excel** danh sách tài liệu kèm toàn bộ trường trích xuất (tiện cho kế toán) |

## Cách chạy

App là các file tĩnh (HTML/JS/CSS), không cần máy chủ riêng. Camera và Google Drive **bắt buộc chạy qua HTTPS**, nên anh đưa thư mục `pdf-scanner/` lên một trong các nơi sau:

- **GitHub Pages (tự động)**: repo có sẵn workflow `.github/workflows/deploy-pdf-scanner.yml`. Bật một lần tại **Settings → Pages → Build and deployment → Source: GitHub Actions** (và bật tab **Actions** nếu GitHub hỏi). Từ đó mỗi lần code trong `pdf-scanner/` được gộp vào nhánh `master`, app tự cập nhật tại **https://sonhieupqc.github.io/n8n/**. Muốn chạy ngay: tab **Actions → Deploy PDF Scanner to GitHub Pages → Run workflow**.
- **Netlify Drop**: vào https://app.netlify.com/drop, kéo thả thư mục `pdf-scanner` là có link `https://…netlify.app`.
- **Thử trên máy tính**: `cd pdf-scanner && python3 -m http.server 8080` rồi mở http://localhost:8080.

Trên điện thoại: mở link → menu trình duyệt → **Thêm vào màn hình chính / Cài đặt ứng dụng**.

## Chế độ AI – mặc định MIỄN PHÍ

Vào **Cài đặt → Chế độ AI** để chọn:

| Chế độ | Chi phí | Làm được gì |
|---|---|---|
| 🔒 **Chỉ trên máy** (mặc định) | Miễn phí, không cần mạng | OCR tiếng Việt chữ in, phân loại, trích xuất số hóa đơn/MST/số tiền, tìm hạn, PDF tìm kiếm được. Dữ liệu không rời khỏi điện thoại. |
| ✨ **Google Gemini** | Miễn phí (giới hạn số lượt mỗi phút/ngày theo chính sách Google) | Thêm: đọc chữ viết tay, bảng biểu phức tạp, tóm tắt thông minh, **hỏi đáp & dịch tài liệu**. |
| 💳 **Claude** | Trả phí theo lượt (tài khoản API riêng) | Chính xác nhất. |

### Lấy key Gemini miễn phí (1 phút)

1. Mở https://aistudio.google.com/apikey và đăng nhập bằng Gmail.
2. Bấm **Create API key** → sao chép key (bắt đầu bằng `AIza…`).
3. Trong app: **Cài đặt → Chế độ AI → Google Gemini**, dán key, bấm **Lưu cài đặt**.

Ô *Model* để trống – app tự chọn bản Gemini "flash" mới nhất mà key dùng được.

> 🔒 **Bảo vệ tài liệu nhạy cảm (bật sẵn):** ở gói miễn phí Google có thể dùng nội dung gửi lên để cải thiện sản phẩm. Vì vậy app luôn đọc trên máy trước; nếu thấy CCCD, hộ chiếu, sao kê ngân hàng, hồ sơ y tế… thì **không gửi lên Google** mà chỉ dùng kết quả trên máy.
>
> Khi hết lượt miễn phí, sai key hoặc mất mạng, app báo bằng tiếng Việt và tự chuyển sang đọc trên máy.

## Khai báo đơn vị / chủ sở hữu

Vào **Cài đặt → Đơn vị / chủ sở hữu**, mỗi dòng một đơn vị, có thể thêm từ khóa nhận diện sau dấu `|`:

```
Cá nhân
Gia đình
Công ty ABC | abc, 0301234567
Cửa hàng XYZ | xyz, siêu thị xyz
```

AI dùng danh sách này để gắn tài liệu vào đúng đơn vị, đặt tên file và sắp thư mục trên Google Drive.

## Cấu hình Google Drive

1. Vào https://console.cloud.google.com → tạo Project (ví dụ *PDF Scanner*).
2. **APIs & Services → Library** → bật **Google Drive API**.
3. **OAuth consent screen**: chọn *External*, điền tên app + email, thêm email của anh vào *Test users*.
4. **Credentials → Create credentials → OAuth client ID** → loại **Web application**
   → ở *Authorized JavaScript origins* thêm địa chỉ app, ví dụ `https://sonhieupqc.github.io` (GitHub Pages) hoặc `https://ten-app.netlify.app` (và `http://localhost:8080` nếu thử trên máy).
5. Copy **Client ID** (`…apps.googleusercontent.com`) → dán vào **Cài đặt → Google Drive** trong app → bấm **Đăng nhập Google**.

App chỉ xin quyền `drive.file`: **chỉ thấy và sửa các file do chính app tạo**, không đọc được các file khác trên Drive của anh.

## Cấu trúc mã nguồn

```
pdf-scanner/
├── index.html            Giao diện (3 tab: Quét, Thư viện, Cài đặt)
├── styles.css            Giao diện mobile-first, hỗ trợ chế độ tối
├── app.js                Điều khiển luồng 4 bước, camera, trình chỉnh trang, thư viện
├── imaging.js            Dò mép giấy, nắn phối cảnh, khử bóng, bộ lọc, đo độ nét, vân tay ảnh, dấu chìm
├── converters.js         PDF (pdf.js), Word (mammoth), Excel (SheetJS) → trang ảnh + chữ gốc
├── gemini.js             Google Gemini (miễn phí): phân tích ảnh có cấu trúc, hỏi đáp, tự chọn model, báo lỗi tiếng Việt
├── ai.js                 OCR kèm tọa độ chữ, phân loại/trích xuất/tìm hạn theo luật, Claude (Anthropic SDK), hỏi đáp
├── pdfbuild.js           Tạo PDF: lớp chữ ẩn (font Roboto tiếng Việt), số trang, dấu chìm, mật khẩu
├── storage.js            IndexedDB (thư viện + phiên quét dở), chia sẻ/tải về, Google Drive, lịch .ics
├── sw.js                 Service worker: chạy offline, nhận file chia sẻ
├── manifest.webmanifest  Thông tin cài đặt PWA
└── icon.svg
```

Thư viện bên ngoài được tải từ `cdn.jsdelivr.net` khi cần lần đầu và lưu đệm để dùng offline.

## Giới hạn hiện tại

- File `.doc` / `.xls` đời rất cũ: `.xls` đọc được; `.doc` cần mở bằng Word và lưu lại thành `.docx`.
- Word/Excel được dựng lại để chuyển PDF, bố cục phức tạp (text box, biểu đồ) có thể khác bản gốc.
- Mật khẩu PDF dùng chuẩn mã hóa cơ bản của PDF (đủ để ngăn mở nhầm), không thay thế được lưu trữ bảo mật chuyên dụng.
- Dữ liệu trong Thư viện nằm trong bộ nhớ trình duyệt của máy: nếu xóa dữ liệu trình duyệt sẽ mất – nên bật lưu Google Drive cho tài liệu quan trọng.
