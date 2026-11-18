/**
 * Kiểm tra bản đóng gói Windows (.exe & NSIS Installer) sau khi chạy electron-builder trên Windows.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function main() {
  console.log('=== [VERIFY WINDOWS BUILD] Kiểm tra sản phẩm đóng gói Windows ===');

  const unpackedExe = path.join(DIST_DIR, 'win-unpacked', 'BiliDownloader.exe');
  const setupExe = path.join(DIST_DIR, `BiliDownloader-Setup-${pkg.version}-x64.exe`);
  const portableExe = path.join(DIST_DIR, `BiliDownloader-Portable-${pkg.version}-x64.exe`);

  assert.ok(fs.existsSync(unpackedExe), `Thiếu file thực thi unpacked: ${unpackedExe}`);
  assert.ok(fs.existsSync(setupExe), `Thiếu bộ cài NSIS: ${setupExe}`);
  assert.ok(fs.existsSync(portableExe), `Thiếu bản Portable: ${portableExe}`);

  const setupSizeMB = fs.statSync(setupExe).size / 1024 / 1024;
  const portableSizeMB = fs.statSync(portableExe).size / 1024 / 1024;
  assert.ok(setupSizeMB > 50, `Bộ cài NSIS quá nhỏ (${setupSizeMB.toFixed(1)} MB)`);
  assert.ok(portableSizeMB > 50, `Bản Portable quá nhỏ (${portableSizeMB.toFixed(1)} MB)`);

  // Kiểm tra FFmpeg & yt-dlp đi kèm trong gói unpacked
  const bundledFfmpeg1 = path.join(DIST_DIR, 'win-unpacked', 'resources', 'bin', 'ffmpeg.exe');
  const bundledFfmpeg2 = path.join(
    DIST_DIR,
    'win-unpacked',
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'ffmpeg-static',
    'ffmpeg.exe'
  );
  assert.ok(
    fs.existsSync(bundledFfmpeg1) || fs.existsSync(bundledFfmpeg2),
    'Thiếu ffmpeg.exe được đóng gói bên trong ứng dụng Windows!'
  );

  const bundledYtdlp = path.join(DIST_DIR, 'win-unpacked', 'resources', 'bin', 'yt-dlp.exe');
  assert.ok(fs.existsSync(bundledYtdlp), 'Thiếu yt-dlp.exe trong resources/bin/');

  // Chạy thử thực tế BiliDownloader.exe --smoke-test trên Windows
  console.log('Đang chạy thử BiliDownloader.exe --smoke-test...');
  const r = spawnSync(unpackedExe, ['--smoke-test'], { encoding: 'utf8', timeout: 30000 });
  console.log('Smoke stdout:', (r.stdout || '').trim());
  if (r.stderr) console.log('Smoke stderr:', r.stderr.trim());
  assert.strictEqual(r.status, 0, `BiliDownloader.exe thoát với mã ${r.status}`);
  assert.ok((r.stdout || '').includes('SMOKE_TEST_OK'), 'Thiếu tín hiệu SMOKE_TEST_OK từ BiliDownloader.exe');

  console.log(`✅ Đã kiểm chứng bản build Windows hợp lệ:`);
  console.log(`   - Unpacked : ${unpackedExe}`);
  console.log(`   - Installer: ${setupExe} (${setupSizeMB.toFixed(1)} MB)`);
  console.log(`   - Portable : ${portableExe} (${portableSizeMB.toFixed(1)} MB)`);
}

main();
