/**
 * Kiểm tra bản đóng gói macOS (.app / .dmg / .zip) sau khi chạy electron-builder --mac.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function main() {
  console.log('=== [VERIFY MACOS BUILD] Kiểm tra sản phẩm đóng gói macOS ===');

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const appDirName = arch === 'arm64' ? 'mac-arm64' : 'mac';
  const appPath = path.join(DIST_DIR, appDirName, 'BiliDownloader.app');
  const appBin = path.join(appPath, 'Contents', 'MacOS', 'BiliDownloader');
  const dmgPath = path.join(DIST_DIR, `BiliDownloader-${pkg.version}-mac-${arch}.dmg`);
  const zipPath = path.join(DIST_DIR, `BiliDownloader-${pkg.version}-mac-${arch}.zip`);

  assert.ok(fs.existsSync(appPath), `Thiếu bundle .app: ${appPath}`);
  assert.ok(fs.existsSync(appBin), `Thiếu file thực thi macOS: ${appBin}`);
  assert.ok(fs.existsSync(dmgPath), `Thiếu bộ cài DMG: ${dmgPath}`);
  assert.ok(fs.existsSync(zipPath), `Thiếu bản nén ZIP: ${zipPath}`);

  const dmgMB = fs.statSync(dmgPath).size / 1024 / 1024;
  const zipMB = fs.statSync(zipPath).size / 1024 / 1024;
  assert.ok(dmgMB > 50, `File DMG quá nhỏ (${dmgMB.toFixed(1)} MB)`);
  assert.ok(zipMB > 50, `File ZIP quá nhỏ (${zipMB.toFixed(1)} MB)`);

  // Kiểm tra FFmpeg & yt-dlp bên trong .app
  const bundledFfmpeg = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    'ffmpeg-static',
    'ffmpeg'
  );
  const bundledYtdlp = path.join(appPath, 'Contents', 'Resources', 'bin', 'yt-dlp');
  assert.ok(fs.existsSync(bundledFfmpeg), `Thiếu FFmpeg trong .app: ${bundledFfmpeg}`);
  assert.ok(fs.existsSync(bundledYtdlp), `Thiếu yt-dlp trong .app: ${bundledYtdlp}`);

  // Chạy thử thực tế BiliDownloader.app
  console.log('Đang chạy thử BiliDownloader.app --smoke-test...');
  const r = spawnSync(appBin, ['--smoke-test'], { encoding: 'utf8', timeout: 30000 });
  console.log('Smoke stdout:', (r.stdout || '').trim());
  if (r.stderr) console.log('Smoke stderr:', r.stderr.trim());
  assert.strictEqual(r.status, 0, `BiliDownloader.app thoát với mã ${r.status}`);
  assert.ok((r.stdout || '').includes('SMOKE_TEST_OK'), 'Thiếu tín hiệu SMOKE_TEST_OK từ BiliDownloader.app');

  console.log('✅ Đã kiểm chứng bản build macOS hợp lệ:');
  console.log(`   - App Bundle : ${appPath}`);
  console.log(`   - DMG        : ${dmgPath} (${dmgMB.toFixed(1)} MB)`);
  console.log(`   - ZIP        : ${zipPath} (${zipMB.toFixed(1)} MB)`);
}

main();
