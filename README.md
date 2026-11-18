# BiliDownloader

Ứng dụng desktop **độc lập hoàn toàn** dành cho **Windows 10/11 (64-bit)** và **macOS** chuyên dùng để phân tích và tải video, audio, danh sách phát và kênh UP chủ từ **Bilibili** (không tích hợp bất kỳ nền tảng nào khác).

## Tính năng chính

- **Nhận diện thông minh link Bilibili**: Hỗ trợ mã `BV` / `AV`, link đầy đủ, link nhiều phần (`?p=`), văn bản chia sẻ hỗn hợp, link rút gọn `b23.tv`, `player.bilibili.com`, Bangumi/PGC (`ep`/`ss`/`md`), Collection/Series/Medialist, Space UP chủ (`space.bilibili.com`) và `bilibili.tv`.
- **Hiển thị đầy đủ thông tin thật từ Bilibili**: Thumbnail, tiêu đề, tên & UID tác giả, avatar, mã BV/AV & CID, thời lượng, ngày đăng, lượt xem, thích, xu, yêu thích, chia sẻ, bình luận, danmaku, mô tả video, danh sách phần (`pages P1..Pn`) và tập playlist.
- **Danh sách chất lượng thực tế (không tạo chất lượng giả)**:
  - Hỗ trợ WBI Sign + DASH (`fnval=4048`) lấy đủ `360P` → `480P` → `720P` → `720P60` → `1080P` → `1080P+` → `1080P60` → `2K` → `4K` → `8K` (tùy video và quyền tài khoản), kèm thông số độ phân giải, FPS, bitrate, codec (`H.264`, `H.265`, `AV1`), các track audio (`Hi-Res FLAC`, `Dolby Atmos`, `AAC`) và ước lượng dung lượng.
  - Kết hợp luồng HTML5 MP4 (`fnval=1`) và fallback `yt-dlp`.
- **Tải & Ghép không giảm chất lượng**:
  - Cho phép tải `Video + Âm thanh`, `Chỉ Video`, hoặc `Chỉ Âm thanh` (`.m4a`, `.mp3`), đổi tên file, chọn thư mục lưu.
  - Tự động ghép luồng DASH hình + tiếng bằng **FFmpeg stream copy (`-c:v copy -c:a copy -movflags +faststart`)** và xác minh giải mã trước khi hoàn tất.
- **Hàng đợi & Điều khiển tải chuyên nghiệp**:
  - Hỗ trợ nhiều tác vụ đồng thời có giới hạn (1–5), **Tạm dừng / Tiếp tục** bằng HTTP `Range`, tự làm mới link CDN khi hết hạn, thử lại khi mạng chập chờn, theo dõi %, MB, tốc độ và ETA.
- **Lịch sử & Quét kênh UP**: Lưu lịch sử mở lại video/thư mục hoặc tải lại từ URL gốc; quét phân trang toàn bộ video trên trang cá nhân `space.bilibili.com`.
- **Bảo mật Cookie**: Hỗ trợ dán Cookie (Header / Netscape / JSON), chỉ gửi tới miền Bilibili, tự động che trong log và không lưu vào metadata.

---

## Cài đặt & Sử dụng trên macOS (Apple Silicon / Intel)

1. Mở trực tiếp **`dist/mac-arm64/BiliDownloader.app`** (hoặc kéo `BiliDownloader.app` từ file **`BiliDownloader-1.0.0-mac-arm64.dmg`** vào thư mục **Applications**).
2. Ngoài ra có thể nhấp đúp **`Start_Mac.command`** để mở nhanh ứng dụng.
3. Nếu macOS Gatekeeper cảnh báo ứng dụng tải ngoài App Store chưa ký Developer ID, mở bằng **Chuột phải → Open**, hoặc chạy:
   ```bash
   xattr -cr /Applications/BiliDownloader.app
   ```

---

## Cài đặt & Sử dụng trên Windows 10/11 (Người dùng cuối)

1. Tải file cài đặt **`BiliDownloader-Setup-<version>-x64.exe`** (hoặc bản chạy ngay không cần cài **`BiliDownloader-Portable-<version>-x64.exe`**) từ trang GitHub Releases / GitHub Actions Artifacts.
2. Chạy `BiliDownloader-Setup-...-x64.exe` và làm theo trình hướng dẫn (đã tích hợp sẵn toàn bộ runtime Electron, `ffmpeg.exe` và `yt-dlp.exe` — **không cần cài Node.js hay Python**).
3. Mở **BiliDownloader** từ Desktop hoặc Start Menu, dán link Bilibili vào ô nhập và bấm **Phân tích**.

> **Mẹo mở khóa 1080P+ / 1080P60 / 4K / 8K:** Vào mục **Cài đặt → Cookie tài khoản Bilibili**, dán chuỗi Cookie đăng nhập Bilibili của chính bạn (có `SESSDATA`) để lấy thêm các luồng chất lượng cao mà tài khoản được phép xem.

---

## Phát triển & Đóng gói từ mã nguồn

### Yêu cầu môi trường phát triển
- Node.js `>= 20` (khuyến nghị Node.js 22 LTS)

### Cài đặt & Chạy thử tại máy phát triển
```bash
npm install
npm run icons
npm start
```

### Chạy bộ kiểm thử tự động
```bash
# Chạy toàn bộ (bao gồm test trực tiếp API Bilibili và tải ghép DASH thật)
npm test

# Chạy offline (bỏ qua test mạng trực tiếp Bilibili)
SKIP_LIVE_BILIBILI=1 npm test
```

### Đóng gói cho macOS (`.app`, `.dmg`, `.zip`)
```bash
npm run fetch-mac-bins
npm run build:mac
npm run verify:mac
```
Sản phẩm tạo ra nằm trong `dist/`:
- `dist/mac-arm64/BiliDownloader.app` (Ứng dụng macOS độc lập)
- `dist/BiliDownloader-<version>-mac-arm64.dmg` (Bộ cài kéo-thả DMG)
- `dist/BiliDownloader-<version>-mac-arm64.zip`

### Đóng gói thành `.exe` trên Windows 10/11 64-bit (hoặc GitHub Actions)
1. Tải binary Windows (`ffmpeg.exe`, `yt-dlp.exe`):
   ```bash
   npm run fetch-win-bins
   ```
2. Đóng gói Installer NSIS (`.exe`) và Portable (`.exe`):
   ```bash
   npm run build:win
   ```
3. Kiểm chứng bản build Windows:
   ```bash
   npm run verify:win
   ```
Sản phẩm tạo ra nằm trong `dist/`:
- `dist/BiliDownloader-Setup-<version>-x64.exe` (Bộ cài đặt Windows NSIS)
- `dist/BiliDownloader-Portable-<version>-x64.exe` (File `.exe` chạy độc lập)
- `dist/win-unpacked/BiliDownloader.exe`

### Đóng gói tự động qua GitHub Actions
Repository này đi kèm sẵn workflow [.github/workflows/build-windows.yml](.github/workflows/build-windows.yml). Khi bạn đẩy mã nguồn **BiliDownloader** lên một **repository GitHub riêng**, GitHub Actions sẽ tự động:
1. Chạy toàn bộ test suite trên cả `windows-latest` và `macos-latest`.
2. Đóng gói `BiliDownloader-Setup-...-x64.exe` và `BiliDownloader-Portable-...-x64.exe` trên `windows-latest`.
3. Chạy thử trực tiếp `BiliDownloader.exe --smoke-test` trên Windows runner và xuất artifact để tải về.
