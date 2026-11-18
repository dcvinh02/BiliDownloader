/**
 * Dịch vụ FFmpeg (Stage 9):
 * - Tự động định vị FFmpeg đóng gói trong ứng dụng (resources/bin/ffmpeg.exe hoặc ffmpeg-static unpacked)
 * - Ưu tiên ghép luồng Video + Audio bằng Stream Copy (-c:v copy -c:a copy -movflags +faststart) để giữ nguyên 100% chất lượng gốc
 * - Hỗ trợ xuất Video-only, Audio-only (.m4a stream copy hoặc .mp3 320kbps)
 * - Kiểm tra tính toàn vẹn file (moov atom, stream video/audio, decode verification) sau khi tải/ghép
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let customFfmpegPath = null;

function setCustomFfmpegPath(p) {
  customFfmpegPath = p || null;
}

function getFfmpegPath() {
  if (customFfmpegPath && fs.existsSync(customFfmpegPath)) return customFfmpegPath;

  const isWin = process.platform === 'win32';
  const osDir = isWin ? 'win' : 'mac';
  const binName = isWin ? 'ffmpeg.exe' : 'ffmpeg';

  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', binName));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', binName));
  }
  candidates.push(path.join(__dirname, '..', 'resources', 'bin', osDir, binName));
  candidates.push(path.join(__dirname, '..', 'resources', 'bin', binName));

  try {
    let ffStatic = require('ffmpeg-static');
    if (ffStatic) {
      if (ffStatic.includes('app.asar') && !ffStatic.includes('app.asar.unpacked')) {
        ffStatic = ffStatic.replace('app.asar', 'app.asar.unpacked');
      }
      candidates.push(ffStatic);
    }
  } catch {}

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return binName; // Fallback PATH
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = String(timeStr).trim().split(':');
  if (parts.length !== 3) return 0;
  const h = parseFloat(parts[0]) || 0;
  const m = parseFloat(parts[1]) || 0;
  const s = parseFloat(parts[2]) || 0;
  return h * 3600 + m * 60 + s;
}

function formatFfmpegError(stderrStr, exitCode) {
  const lower = String(stderrStr || '').toLowerCase();
  if (lower.includes('no space left on device') || lower.includes('enospc')) {
    return 'Ổ đĩa hết dung lượng trống (No space left on device). Hãy giải phóng dung lượng hoặc đổi thư mục lưu.';
  }
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return 'Không có quyền ghi file vào thư mục lưu trữ (Permission denied).';
  }
  if (lower.includes('moov atom not found') || lower.includes('invalid data found')) {
    return 'File tải về chưa hoàn chỉnh hoặc bị hỏng cấu trúc (moov atom not found).';
  }
  const lines = String(stderrStr || '').trim().split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-3).join(' | ');
  return tail || `FFmpeg dừng với mã lỗi ${exitCode}`;
}

/**
 * Kiểm tra cấu trúc và khả năng giải mã của file media đầu ra bằng FFmpeg.
 */
function probeMedia(filePath, options = {}) {
  return new Promise((resolve) => {
    const ffmpeg = getFfmpegPath();
    if (!filePath || !fs.existsSync(filePath)) {
      return resolve({ valid: false, error: 'File không tồn tại để kiểm tra.' });
    }
    const stat = fs.statSync(filePath);
    if (stat.size < 256) {
      return resolve({ valid: false, error: 'File đầu ra rỗng hoặc quá nhỏ (< 256 bytes).' });
    }

    const args = ['-hide_banner', '-i', filePath];
    if (options.verifyDecode) {
      // Giữ mức log mặc định (info) để vừa đọc được thông tin Stream vừa kiểm tra giải mã tới null
      args.push('-c', 'copy', '-f', 'null', '-');
    }

    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
    }, 20000);

    proc.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ valid: false, error: `Không chạy được FFmpeg: ${err.message}` });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const durMatch = stderr.match(/Duration:\s*(\d{2}:\d{2}:\d{2}\.\d+)/);
      const duration = durMatch ? parseTimeToSeconds(durMatch[1]) : 0;

      const vMatch = stderr.match(/Stream\s+#\d+:\d+.*Video:\s*([a-zA-Z0-9_]+)(?:\s*\([^)]*\))?(?:\s*\(([a-zA-Z0-9_]+))?/);
      const vcodec = vMatch ? vMatch[1].toLowerCase() : '';
      const vtag = vMatch && vMatch[2] ? vMatch[2].toLowerCase() : '';

      const resMatch = stderr.match(/Stream\s+#\d+:\d+.*Video:.*,\s*(\d{2,5})x(\d{2,5})/);
      const width = resMatch ? parseInt(resMatch[1], 10) : null;
      const height = resMatch ? parseInt(resMatch[2], 10) : null;

      const aMatch = stderr.match(/Stream\s+#\d+:\d+.*Audio:\s*([a-zA-Z0-9_]+)/);
      const acodec = aMatch ? aMatch[1].toLowerCase() : '';

      const hasFatal =
        stderr.includes('moov atom not found') ||
        stderr.includes('Invalid data found when processing input');

      // Khi không truyền -f null, ffmpeg -i trả exit code 1 do không có output file nhưng vẫn in đầy đủ Stream info
      const hasAnyStream = Boolean(vcodec || acodec);
      const valid = hasAnyStream && !hasFatal && (options.verifyDecode ? code === 0 : true);

      resolve({
        valid,
        error: valid ? null : formatFfmpegError(stderr, code),
        fileSize: stat.size,
        duration,
        vcodec,
        vtag,
        acodec,
        width,
        height,
        hasVideo: Boolean(vcodec),
        hasAudio: Boolean(acodec)
      });
    });
  });
}

function runFfmpegCommand(args, { totalDuration = 0, onProgress = () => {}, cancelHandle = null } = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = getFfmpegPath();
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let isCancelled = false;

    if (cancelHandle) {
      cancelHandle.kill = () => {
        isCancelled = true;
        try {
          proc.kill('SIGTERM');
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 400);
        } catch {}
      };
    }

    proc.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderr = (stderr + s).slice(-8000);
      const tm = s.match(/time=(\d{2}:\d{2}:\d{2}\.\d+)/);
      if (tm && totalDuration > 0) {
        const cur = parseTimeToSeconds(tm[1]);
        const pct = Math.min(99, Math.round((cur / totalDuration) * 100));
        onProgress(pct);
      }
    });

    proc.on('error', (err) => reject(new Error(`Lỗi khởi chạy FFmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (isCancelled) return reject(new Error('USER_CANCELLED'));
      if (code !== 0) return reject(new Error(formatFfmpegError(stderr, code)));
      resolve();
    });
  });
}

/**
 * Ghép luồng Video + Audio (hoặc đóng gói lại 1 luồng) giữ nguyên chất lượng gốc (stream copy).
 */
async function muxOrConvertStreams({
  videoPath = null,
  audioPath = null,
  outputPath,
  outputFormat = 'mp4',
  mode = 'video_audio', // 'video_audio' | 'video_only' | 'audio_only'
  videoCodecKey = 'avc',
  duration = 0,
  onProgress = () => {},
  cancelHandle = null
}) {
  const fmt = String(outputFormat || 'mp4').toLowerCase();
  const tmpOut = `${outputPath}.muxing.${fmt}`;

  if (fs.existsSync(tmpOut)) {
    try { fs.unlinkSync(tmpOut); } catch {}
  }

  const args = ['-y', '-hide_banner'];

  if (mode === 'audio_only') {
    const src = audioPath || videoPath;
    if (!src || !fs.existsSync(src)) throw new Error('Không tìm thấy file luồng âm thanh nguồn.');
    args.push('-i', src, '-vn');
    if (fmt === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', '320k');
    } else if (fmt === 'flac') {
      args.push('-c:a', 'flac');
    } else {
      // m4a: ưu tiên stream copy giữ nguyên âm thanh gốc
      args.push('-c:a', 'copy');
    }
    args.push(tmpOut);
  } else if (mode === 'video_only') {
    if (!videoPath || !fs.existsSync(videoPath)) throw new Error('Không tìm thấy file luồng hình ảnh nguồn.');
    args.push('-i', videoPath, '-an', '-c:v', 'copy');
    if (fmt === 'mp4' && videoCodecKey === 'hevc') {
      args.push('-tag:v', 'hvc1');
    }
    if (fmt === 'mp4' || fmt === 'mov') {
      args.push('-movflags', '+faststart');
    }
    args.push(tmpOut);
  } else {
    // video_audio
    if (!videoPath || !fs.existsSync(videoPath)) throw new Error('Không tìm thấy file luồng video nguồn.');
    args.push('-i', videoPath);
    if (audioPath && fs.existsSync(audioPath)) {
      args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0');
    }
    // Luôn ưu tiên stream copy để không làm giảm chất lượng video
    args.push('-c:v', 'copy');
    if (audioPath || fmt !== 'mp4') {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'copy');
    }
    if (fmt === 'mp4' && videoCodecKey === 'hevc') {
      args.push('-tag:v', 'hvc1');
    }
    if (fmt === 'mp4' || fmt === 'mov') {
      args.push('-movflags', '+faststart');
    }
    args.push(tmpOut);
  }

  try {
    await runFfmpegCommand(args, { totalDuration: duration, onProgress, cancelHandle });
    const check = await probeMedia(tmpOut, { verifyDecode: true });
    if (!check.valid) {
      throw new Error(check.error || 'File đầu ra không vượt qua kiểm tra toàn vẹn FFmpeg.');
    }
    if (mode !== 'audio_only' && !check.hasVideo) {
      throw new Error('File đầu ra bị thiếu luồng hình ảnh.');
    }
    if (mode === 'audio_only' && !check.hasAudio) {
      throw new Error('File âm thanh đầu ra không có luồng Audio.');
    }

    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    fs.renameSync(tmpOut, outputPath);
    return check;
  } catch (err) {
    if (fs.existsSync(tmpOut)) {
      try { fs.unlinkSync(tmpOut); } catch {}
    }
    throw err;
  }
}

module.exports = {
  setCustomFfmpegPath,
  getFfmpegPath,
  probeMedia,
  muxOrConvertStreams
};
