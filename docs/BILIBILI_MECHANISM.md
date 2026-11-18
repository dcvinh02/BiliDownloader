# Tài liệu Phân tích Cơ chế Bilibili (CNDownload -> BiliDownloader)

## 1. Tổng quan phân tích từ CNDownload

Qua kiểm tra trực tiếp mã nguồn CNDownload (`src/extractors/platforms.js`, `src/extractors/custom_parsers.js`, `src/extractors/index.js`, `src/extractors/ytdlp_engine.js`, `src/converter_engine.js`, `src/account_scanner.js`, `src/server.js`), cơ chế xử lý Bilibili của CNDownload hoạt động theo 5 tầng:

### 1.1. Nhận diện & chuẩn hóa URL (`src/extractors/platforms.js`)
- Miền nhận diện: `bilibili.com`, `bilibili.tv`, `b23.tv`, `player.bilibili.com`, `m.bilibili.com`.
- Tách link từ chuỗi văn bản chia sẻ hỗn hợp hoặc thẻ `<iframe src="...">` (`extractUrlFromText`).
- Trích xuất Video ID (`extractVideoId`):
  - Tham số query: `bvid`, `aid` (chuyển sang `av<aid>`).
  - Đường dẫn: `/(BV[a-zA-Z0-9]{10}|av\d+)/i` và mẫu ID số cho `bilibili.tv`.
- Giữ lại tham số phân trang `?p=` (`preserveQueryKeys: ['p']`), tạo canonical link `https://www.bilibili.com/video/${videoId}` và player nhúng `https://player.bilibili.com/player.html?bvid=${videoId}&high_quality=1&danmaku=0`.
- Với link rút gọn `b23.tv/...`: `resolveRedirect` thực hiện tối đa 5 hop theo dõi `301/302` (`redirect: 'manual'`, timeout `4000ms`/hop), giữ lại `Set-Cookie`.

### 1.2. Lấy thông tin video (`parseBilibili` trong `src/extractors/custom_parsers.js`)
- Gọi API công khai: `https://api.bilibili.com/x/web-interface/view?bvid=...` (hoặc `aid=...`).
- Header bắt buộc: `User-Agent` Desktop Chrome, `Referer: https://www.bilibili.com/`, kèm `Cookie` nếu người dùng cung cấp.
- Kiểm tra HTTP `412` hoặc HTML trả về (`/^\s*</`) để báo lỗi rate-limit/chặn rõ ràng.
- Dữ liệu trả về: `bvid`, `cid`, `title`, `desc`, `owner.name`, `owner.face`, `pic`, `duration`, `stat` (`view`, `like`, `coin`, `favorite`, `share`, `reply`).

### 1.3. Lấy luồng phát & giới hạn của CNDownload
- CNDownload gọi song song 2 request `https://api.bilibili.com/x/player/playurl` với `fnval=1&platform=html5` (`qn=80` và `qn=16`).
- Cờ `fnval=1` chỉ trả về luồng progressive MP4 trong `data.durl` (tối đa ~720P/1080P thường ghép sẵn). Vì `directVideoUrl` đã có giá trị, nhánh fallback `yt-dlp` trong `src/extractors/index.js` bị bỏ qua.
- Chỉ khi là `bilibili.tv` hoặc `parseBilibili` thất bại, CNDownload mới gọi `extractWithYtDlp` (`yt-dlp --dump-single-json`) để lấy danh sách DASH `.m4s`.

### 1.4. Tải dữ liệu, ghép FFmpeg & kiểm tra toàn vẹn
- **Direct MP4 (`isDirectHttpMp4`)**: `fetch` stream HTTP trực tiếp kèm `Referer: https://www.bilibili.com/` và Cookie được cách ly theo miền (`bilibili.com`, `bilivideo.com`, `b23.tv`).
- **Tách luồng / DASH / HLS**: gọi `downloadWithYtDlp` kèm `--ffmpeg-location`, `-S vcodec:h264,res,acodec:m4a --merge-output-format mp4 --postprocessor-args Merger+ffmpeg:-movflags +faststart`.
- **Xác minh sau tải (`converter_engine.js`)**: dùng FFmpeg đọc thông tin giải mã (`probeMediaFile`), xác nhận không lỗi `moov atom`, đúng luồng hình/tiếng. Nếu đã là H.264 tương thích thì giữ nguyên; chỉ chuyển mã khi gặp `hev1`/phân mảnh DASH không tương thích hoặc người dùng chọn đổi định dạng.

### 1.5. Quét kênh UP chủ & Proxy hiển thị
- Quét kênh (`space.bilibili.com/{mid}`): lấy hồ sơ qua `x/web-interface/card?mid={mid}` (hoặc `x/web-interface/search/type?search_type=bili_user`), liệt kê danh sách upload qua `yt-dlp --flat-playlist -J`, và bổ sung metadata qua `x/web-interface/view` có giới hạn 3 luồng + nghỉ `150ms`.
- Proxy ảnh/video (`server.js` `/api/proxy-media`): CDN `hdslb.com` / `bilivideo.com` chặn HTTP 403 nếu thiếu `Referer: https://www.bilibili.com/`, nên server đứng giữa truyền lại header `Referer` và hỗ trợ `Range`.

---

## 2. Những điểm kế thừa và nâng cấp trong BiliDownloader

| Khía cạnh | CNDownload | BiliDownloader (Phiên bản độc lập) |
| :--- | :--- | :--- |
| Phạm vi nền tảng | 12 nền tảng Trung Quốc | Duy nhất **Bilibili** (`bilibili.com`, `b23.tv`, `bilibili.tv`, `space`, `ep/ss`) |
| Metadata video | Thiếu `pubdate`, `owner.mid`, `pages[]` (nhiều phần), `danmaku` | Hiển thị đầy đủ mọi trường thật từ `view` API + toàn bộ danh sách phần (`pages P1..Pn`) + Collection/Series + Bangumi/PGC |
| Lấy chất lượng | Chỉ `fnval=1` HTML5 MP4 (`durl`) | Mở rộng **DASH (`fnval=4048&fourk=1`) + WBI Sign (`/x/web-interface/nav`)**: hiển thị đủ 360P → 8K, codec (`AVC`/`HEVC`/`AV1`), FPS, bitrate, ước lượng dung lượng, luồng audio (`AAC`/`Hi-Res`/`Dolby`), kèm fallback HTML5 `durl` & `yt-dlp` |
| Ghép & Chất lượng | `yt-dlp` ghép + đôi khi re-encode `libx264` | Tự tải song song luồng Video + Audio được chọn và ghép bằng FFmpeg **stream copy (`-c:v copy -c:a copy -movflags +faststart`)** để giữ nguyên 100% chất lượng gốc; chỉ tách/đổi định dạng khi người dùng yêu cầu |
| Điều khiển tải | Chỉ có Hủy (Cancel), mất phần đã tải | Hỗ trợ **Tạm dừng / Tiếp tục (HTTP Range `.part`)**, **Thử lại**, **Hàng đợi giới hạn N tác vụ đồng thời**, **Chọn thư mục & đổi tên file**, tải cả video / chỉ video / chỉ audio |
| Bảo mật Cookie | Cách ly miền & xóa khỏi metadata | Cách ly miền nghiêm ngặt (`bilibili.com`, `bilivideo.com`, `b23.tv`), tự động che (`[REDACTED]`) trong log và loại bỏ khỏi mọi file metadata |
| Đóng gói Windows | Cần cài Node.js + biên dịch WebView2 C# trên máy đích | Độc lập hoàn toàn qua Electron + `electron-builder` (NSIS Installer `.exe` + Portable `.exe` + tích hợp `ffmpeg.exe` & `yt-dlp.exe`) |

---

## 3. Luồng xử lý từ URL đến File xuất

1. **Nhận diện & Phân loại URL** (`core/urlParser.js`): Tách URL từ văn bản -> Nếu là `b23.tv` thực hiện resolve redirect -> Phân loại `video` (`BV`/`av`, kèm `?p=`), `pgc` (`ep`/`ss`), `collection` (`season_id`/`series_id`), `space` (`space.bilibili.com/{mid}`), hoặc `bilibili_tv`.
2. **Trích xuất Metadata & Playlist** (`core/bilibiliApi.js`):
   - Video thường: `GET /x/web-interface/view` -> lấy title, desc, pubdate, owner (`name`, `mid`, `face`), `pic`, `duration`, `stat`, `pages[]`, `ugc_season` (nếu thuộc playlist/collection).
   - PGC công khai: `GET /pgc/view/web/season` -> lấy danh sách tập (`episodes[]`) và `bvid`/`cid`/`ep_id`.
3. **Ký WBI & Truy xuất Luồng thực tế** (`core/wbiSigner.js` + `core/bilibiliApi.js`):
   - Lấy cặp khóa `img_key` & `sub_key` từ `/x/web-interface/nav` (cache ngắn hạn).
   - Ký WBI (`w_rid`, `wts`) và gọi `/x/player/wbi/playurl` với `fnval=4048&fourk=1&fnver=0&qn=127` (hoặc `/pgc/player/web/v2/playurl` cho PGC).
   - Fallback sang `/x/player/playurl` (`fnval=1&platform=html5`) để lấy luồng progressive MP4 `durl` nếu cần, và `yt-dlp` cho các trường hợp đặc biệt (`bilibili.tv` / lỗi API).
   - Chuẩn hóa thành danh sách thực tế các luồng Video (theo `qn`, `codecid`, `width x height`, `frameRate`, `bandwidth`, `sizeEstimate`) và Audio (`id`, `bandwidth`, `codecs`, `sizeEstimate`) — **tuyệt đối không tạo chất lượng giả**.
4. **Tải dữ liệu & Điều phối Hàng đợi** (`core/downloadManager.js`):
   - Chạy tối đa `maxConcurrent` tác vụ đồng thời.
   - Tải luồng bằng `fetch` + HTTP `Range` (`bytes=<offset>-`) hỗ trợ **Pause / Resume** bền vững vào file `.part` với retry có giới hạn và timeout hợp lý.
   - Nếu chọn chế độ Video + Audio và luồng là DASH tách rời: tải riêng `.video.m4s` và `.audio.m4s`.
5. **Ghép FFmpeg & Xác minh** (`core/ffmpegService.js`):
   - Ghép 2 luồng bằng `ffmpeg -y -i video.m4s -i audio.m4s -c:v copy -c:a copy -movflags +faststart output.mp4` (ưu tiên stream copy giữ nguyên 100% chất lượng gốc).
   - Xác minh file đầu ra tồn tại, dung lượng hợp lệ, không lỗi `moov atom`, kiểm tra stream hình/tiếng bằng FFmpeg probe trước khi chuyển sang trạng thái **Hoàn thành** và ghi vào Lịch sử (`core/storageStore.js`).
