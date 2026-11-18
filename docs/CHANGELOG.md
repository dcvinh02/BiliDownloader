# Nhật ký Thay đổi (CHANGELOG)

## [1.0.0] - 2026-11-18
### [Giai đoạn 1–3] Phân tích CNDownload & Thiết kế kiến trúc
- Phân tích mã nguồn CNDownload (`platforms.js`, `custom_parsers.js`, `index.js`, `ytdlp_engine.js`, `converter_engine.js`, `account_scanner.js`, `server.js`).
- Ghi nhận giới hạn `fnval=1` của CNDownload và thiết kế cơ chế nâng cấp DASH (`fnval=4048` + WBI signing + guest `buvid3/buvid4` từ `/x/frontend/finger/spi`).

### [Giai đoạn 4–5] Cấu trúc project, bảo mật Cookie & phân tích URL
- Khởi tạo git repo độc lập `/Users/nguyentuan/Documents/VINH/tools/BiliDownloader`.
- Triển khai `core/constants.js`, `core/logger.js` (tự động che Cookie/SESSDATA), `core/cookieStore.js` (cách ly domain, hỗ trợ Header/Netscape/JSON).
- Triển khai `core/urlParser.js` nhận diện BV/AV, `b23.tv` redirect, `?p=`, Bangumi `ep/ss/md`, Collection/Series, Space và từ chối mọi nền tảng ngoài Bilibili.

### [Giai đoạn 6–9] API Bilibili, Chất lượng DASH, Tải & Ghép FFmpeg
- Triển khai `core/wbiSigner.js` và `core/bilibiliApi.js` (View, PlayURL WBI DASH + HTML5 MP4, PGC, Collection, Space WBI + `yt-dlp` fallback).
- Triển khai `core/ffmpegService.js` ưu tiên ghép stream copy `-c:v copy -c:a copy -movflags +faststart` + `probeMedia` kiểm tra giải mã.
- Triển khai `core/downloadManager.js` hỗ trợ hàng đợi giới hạn đồng thời, HTTP `Range` Pause/Resume, mirror fallback, làm mới link CDN hết hạn và xuất Video+Audio / Chỉ Video / Chỉ Audio.

### [Giai đoạn 10–13] Giao diện Desktop, Kiểm thử toàn diện & Đóng gói Windows
- Xây dựng Electron shell (`electron/main.js`, `electron/preload.js`, Local Media Proxy chống 403 `hdslb.com`) và giao diện desktop 5 tab (`renderer/`).
- Sửa lỗi phát hiện qua test: lỗi `probeMedia -v error` làm ẩn thông tin stream, unhandled `AbortError` khi gọi `reader.cancel()` lúc Pause, thiếu guest `buvid3/buvid4` gây HTTP 412, và thứ tự ưu tiên chất lượng giữa DASH và HTML5 MP4.
- Tạo bộ icon đa kích thước (`assets/icon.ico`, `icon.png`, `icon.svg`), script tải binary Windows (`scripts/fetch-win-binaries.js`), kiểm tra build (`scripts/verify-windows-build.js`), và workflow GitHub Actions `.github/workflows/build-windows.yml`.
