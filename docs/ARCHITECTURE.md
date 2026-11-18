# Kiến trúc Ứng dụng Độc lập — BiliDownloader

## 1. Mục tiêu thiết kế
- **Độc lập tuyệt đối**: Không phụ thuộc CNDownload, Python, Node.js hay trình duyệt ngoài khi chạy trên Windows 10/11 64-bit.
- **Tách lớp rõ ràng (Core / Electron / Renderer)**: Mọi logic mạng, Bilibili API, ký WBI, quản lý hàng đợi tải, FFmpeg nằm hoàn toàn trong `core/` để có thể kiểm thử tự động độc lập không cần GUI.
- **Bảo mật dữ liệu nhạy cảm**: Cookie (như `SESSDATA`, `bili_jct`) chỉ gửi tới các domain được phép (`*.bilibili.com`, `*.bilivideo.com`, `*.b23.tv`), tự động che trong toàn bộ log (`core/logger.js`) và không lưu vào metadata JSON cạnh file tải về.

## 2. Cấu trúc thư mục

```text
BiliDownloader/
├── core/                  # Lõi xử lý thuần Node.js (không phụ thuộc Electron UI)
│   ├── constants.js       # Bảng mã chất lượng Bilibili (qn 16..127), codec, audio id, header chuẩn
│   ├── logger.js          # Logger an toàn (redaction Cookie/Token), lưu file log xoay vòng
│   ├── cookieStore.js     # Đọc/phân tích Cookie (Header/Netscape/JSON), kiểm tra domain hợp lệ
│   ├── urlParser.js       # Tách URL từ text, giải mã b23.tv, nhận diện BV/AV/ep/ss/space/series
│   ├── wbiSigner.js       # Ký WBI (img_key/sub_key + mixin table + MD5 w_rid/wts)
│   ├── bilibiliApi.js     # Gọi WebAPI (view, playurl DASH/HTML5, pgc, collection, space card/uploads)
│   ├── ytdlpFallback.js   # Wrapper yt-dlp cho Space uploads (--flat-playlist) & fallback đặc biệt
│   ├── ffmpegService.js   # Tìm FFmpeg đóng gói, ghép stream copy (-c copy), tách audio, verify media
│   ├── downloadManager.js # Hàng đợi tải đa luồng giới hạn N tác vụ, HTTP Range Pause/Resume, Retry
│   ├── storageStore.js    # Lưu cấu hình, Cookie cục bộ, Lịch sử tải (atomic write JSON)
│   └── index.js           # API thống nhất xuất cho Electron Main & bộ test
├── electron/
│   ├── main.js            # Cửa sổ Electron, single-instance lock, IPC bridge, Media Proxy nội bộ
│   └── preload.js         # ContextBridge an toàn cho Renderer
├── renderer/
│   ├── index.html         # Giao diện chính (Sidebar + 4 màn hình chức năng)
│   ├── styles.css         # Hệ thống giao diện trung tính Sáng/Tối phong cách Windows Desktop
│   └── app.js             # Quản lý state UI, hiển thị metadata, bảng chất lượng, hàng đợi & lịch sử
├── assets/                # Icon (.svg, .png, .ico)
├── scripts/               # Tạo icon, tải binary Windows (ffmpeg.exe, yt-dlp.exe), kiểm tra build
├── tests/                 # Bộ kiểm thử đơn vị và tích hợp theo từng giai đoạn
└── .github/workflows/     # CI/CD tự động build & verify .exe + NSIS installer trên windows-latest
```

## 3. Giao tiếp giữa các lớp
1. **Renderer (`renderer/app.js`)** gọi qua `window.biliApi.*` (khai báo ở `electron/preload.js`).
2. **Electron Main (`electron/main.js`)** nhận IPC, điều phối tới `core/index.js`, đồng thời đẩy sự kiện tiến độ tải (`download:update`), log và trạng thái hàng đợi về Renderer theo thời gian thực.
3. **Local Media Proxy (`127.0.0.1:<random_port>`)** trong `electron/main.js` phục vụ ảnh thumbnail/avatar (`hdslb.com`) và video preview (`bilivideo.com`) với header `Referer: https://www.bilibili.com/` để thẻ `<img>`/`<video>` hiển thị mượt mà không gặp lỗi HTTP 403.
