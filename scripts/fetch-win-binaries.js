/**
 * Tải sẵn binary Windows x64 (yt-dlp.exe và kiểm tra ffmpeg.exe) vào resources/bin/
 * để đóng gói hoàn toàn độc lập (self-contained) trong bộ cài đặt .exe.
 */

const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', 'resources', 'bin');

async function downloadFile(url, destPath) {
  console.log(`Đang tải ${url} -> ${destPath}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Tải thất bại HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf);
  console.log(`✅ Đã lưu ${path.basename(destPath)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // 1. yt-dlp.exe
  const ytdlpPath = path.join(BIN_DIR, 'yt-dlp.exe');
  if (!fs.existsSync(ytdlpPath) || fs.statSync(ytdlpPath).size < 1024 * 1024) {
    await downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', ytdlpPath);
  } else {
    console.log('✅ Đã có resources/bin/yt-dlp.exe');
  }

  // 2. Kiểm tra ffmpeg.exe (trên Windows CI ffmpeg-static cài sẵn ffmpeg.exe; nếu chưa có thì copy/kiểm tra)
  const ffmpegStaticWin = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
  const ffmpegResWin = path.join(BIN_DIR, 'ffmpeg.exe');
  if (fs.existsSync(ffmpegStaticWin)) {
    fs.copyFileSync(ffmpegStaticWin, ffmpegResWin);
    console.log(`✅ Đã đồng bộ ffmpeg.exe từ ffmpeg-static (${(fs.statSync(ffmpegResWin).size / 1024 / 1024).toFixed(1)} MB)`);
  } else if (fs.existsSync(ffmpegResWin)) {
    console.log('✅ Đã có resources/bin/ffmpeg.exe');
  } else {
    console.log('ℹ️ Chưa có ffmpeg.exe cục bộ (chỉ cần khi chạy/đóng gói trên Windows).');
  }
}

main().catch((err) => {
  console.error('❌ Lỗi tải binary Windows:', err);
  process.exit(1);
});
