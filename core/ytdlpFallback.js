/**
 * Lớp dự phòng & hỗ trợ yt-dlp cho BiliDownloader:
 * - Dùng khi quét danh sách video kênh UP chủ (space.bilibili.com) nếu Space WBI API bị chặn (-352)
 * - Dùng làm fallback cho link bilibili.tv hoặc trường hợp đặc biệt mà WebAPI trực tiếp không trích xuất được.
 * - Quản lý file cookie Netscape tạm (quyền 0600) và tự xóa ngay sau khi tiến trình kết thúc.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DESKTOP_UA, BILIBILI_REFERER } = require('./constants');
const { createTempNetscapeCookieFile, isBilibiliCookieAllowedUrl } = require('./cookieStore');
const logger = require('./logger');

let customYtDlpPath = null;

function setCustomYtDlpPath(p) {
  customYtDlpPath = p || null;
}

function getYtDlpPath() {
  if (customYtDlpPath && fs.existsSync(customYtDlpPath)) return customYtDlpPath;

  const isWin = process.platform === 'win32';
  const osDir = isWin ? 'win' : 'mac';
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', binName));
  }
  candidates.push(path.join(__dirname, '..', 'resources', 'bin', osDir, binName));
  candidates.push(path.join(__dirname, '..', 'resources', 'bin', binName));
  candidates.push(path.join(__dirname, '..', 'bin', binName));

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return binName; // Fallback vào PATH hệ thống
}

function isYtDlpAvailable() {
  const bin = getYtDlpPath();
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  return true; // Có thể có trong PATH; khi spawn sẽ kiểm tra lỗi ENOENT
}

function extractViaYtDlp(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const bin = getYtDlpPath();
    const args = [
      '--dump-single-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificates',
      '--socket-timeout',
      '15',
      '--referer',
      options.referer || BILIBILI_REFERER,
      '--user-agent',
      DESKTOP_UA
    ];

    if (options.ffmpegPath) {
      args.push('--ffmpeg-location', options.ffmpegPath);
    }

    let tmpCookieFile = null;
    if (options.cookie && isBilibiliCookieAllowedUrl(targetUrl)) {
      tmpCookieFile = createTempNetscapeCookieFile(options.cookie);
      if (tmpCookieFile) args.push('--cookies', tmpCookieFile);
    }

    args.push(targetUrl);

    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try { fs.unlinkSync(tmpCookieFile); } catch {}
      }
      return reject(err);
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('yt-dlp phân tích quá thời gian chờ (25s).'));
    }, 25000);

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    const cleanup = () => {
      clearTimeout(timer);
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try { fs.unlinkSync(tmpCookieFile); } catch {}
      }
    };

    proc.on('error', (err) => {
      cleanup();
      reject(new Error(`Không chạy được yt-dlp: ${err.message}`));
    });

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0 || !stdout.trim()) {
        return reject(new Error(logger.redactSensitiveText(stderr.trim() || `yt-dlp exited with code ${code}`)));
      }
      try {
        const info = JSON.parse(stdout);
        resolve(info);
      } catch (e) {
        reject(new Error(`Lỗi đọc dữ liệu JSON từ yt-dlp: ${e.message}`));
      }
    });
  });
}

function fetchSpaceUploadsViaYtDlp({ mid, page = 1, pageSize = 20, cookie = '' }) {
  return new Promise((resolve) => {
    const bin = getYtDlpPath();
    const start = (page - 1) * pageSize + 1;
    const end = page * pageSize;
    const targetUrl = `https://space.bilibili.com/${mid}/video`;
    const args = [
      '--flat-playlist',
      '-J',
      '--no-warnings',
      '--socket-timeout',
      '20',
      '--playlist-items',
      `${start}-${end}`,
      '--user-agent',
      DESKTOP_UA
    ];

    let tmpCookieFile = null;
    if (cookie) {
      tmpCookieFile = createTempNetscapeCookieFile(cookie);
      if (tmpCookieFile) args.push('--cookies', tmpCookieFile);
    }
    args.push(targetUrl);

    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try { fs.unlinkSync(tmpCookieFile); } catch {}
      }
      return resolve({ ok: false, items: [], hasMore: false, error: `Không tìm thấy yt-dlp: ${e.message}` });
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 60000);

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-2000); });

    const cleanup = () => {
      clearTimeout(timer);
      if (tmpCookieFile && fs.existsSync(tmpCookieFile)) {
        try { fs.unlinkSync(tmpCookieFile); } catch {}
      }
    };

    proc.on('error', (err) => {
      cleanup();
      resolve({ ok: false, items: [], hasMore: false, error: `Không chạy được yt-dlp: ${err.message}` });
    });

    proc.on('close', (code) => {
      cleanup();
      if (code !== 0 || !stdout.trim()) {
        const cleanErr = logger.redactSensitiveText(stderr.trim());
        let msg = `yt-dlp không liệt kê được video (mã ${code}): ${cleanErr.slice(-300)}`;
        if (/352|rejected by server/i.test(cleanErr)) {
          msg = cookie
            ? 'Bilibili từ chối yêu cầu (mã 352). Cookie có thể đã hết hạn, hãy cập nhật SESSDATA mới.'
            : 'Bilibili yêu cầu đăng nhập (mã 352) để quét trang cá nhân. Hãy thêm Cookie Bilibili trong phần Cài đặt.';
        }
        return resolve({ ok: false, items: [], hasMore: false, error: msg });
      }
      try {
        const j = JSON.parse(stdout);
        const entries = Array.isArray(j.entries) ? j.entries : [];
        const items = entries
          .map((e) => {
            const bvid = String(e.id || '').match(/BV[0-9A-Za-z]{10}/i)?.[0] || String(e.url || '').match(/BV[0-9A-Za-z]{10}/i)?.[0] || '';
            if (!bvid) return null;
            return {
              bvid,
              title: e.title || bvid,
              url: `https://www.bilibili.com/video/${bvid}`,
              cover: (e.thumbnails && e.thumbnails[0] && e.thumbnails[0].url) || e.thumbnail || '',
              duration: Number(e.duration) || 0,
              views: Number(e.view_count) || 0,
              pubdate: Number(e.timestamp) || 0
            };
          })
          .filter(Boolean);
        resolve({
          ok: true,
          items,
          hasMore: items.length >= pageSize,
          totalCount: Number(j.playlist_count) || null
        });
      } catch (e) {
        resolve({ ok: false, items: [], hasMore: false, error: `Lỗi phân tích JSON yt-dlp: ${e.message}` });
      }
    });
  });
}

module.exports = {
  setCustomYtDlpPath,
  getYtDlpPath,
  isYtDlpAvailable,
  extractViaYtDlp,
  fetchSpaceUploadsViaYtDlp
};
