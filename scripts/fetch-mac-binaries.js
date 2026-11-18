/**
 * Tải sẵn binary macOS (yt-dlp_macos) vào resources/bin/mac/yt-dlp
 * và kiểm tra ffmpeg từ ffmpeg-static để đóng gói bản macOS (.app / .dmg / .zip) hoàn chỉnh.
 */

const fs = require('fs');
const path = require('path');

const BIN_DIR = path.join(__dirname, '..', 'resources', 'bin', 'mac');

async function downloadFile(url, destPath) {
  console.log(`Đang tải ${url} -> ${destPath}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Tải thất bại HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buf, { mode: 0o755 });
  fs.chmodSync(destPath, 0o755);
  console.log(`✅ Đã lưu ${path.basename(destPath)} (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  const ytdlpPath = path.join(BIN_DIR, 'yt-dlp');
  if (!fs.existsSync(ytdlpPath) || fs.statSync(ytdlpPath).size < 1024 * 1024) {
    await downloadFile('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', ytdlpPath);
  } else {
    fs.chmodSync(ytdlpPath, 0o755);
    console.log('✅ Đã có resources/bin/mac/yt-dlp');
  }

  const ffmpegStatic = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg');
  if (fs.existsSync(ffmpegStatic)) {
    console.log(`✅ FFmpeg macOS sẵn sàng từ ffmpeg-static (${(fs.statSync(ffmpegStatic).size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    throw new Error('Thiếu node_modules/ffmpeg-static/ffmpeg. Hãy chạy: node node_modules/ffmpeg-static/install.js');
  }
}

main().catch((err) => {
  console.error('❌ Lỗi chuẩn bị binary macOS:', err);
  process.exit(1);
});
