/**
 * Trình quản lý Tải xuống & Hàng đợi (Stage 8):
 * - Hỗ trợ nhiều tác vụ đồng thời với giới hạn maxConcurrent
 * - Hỗ trợ đầy đủ các trạng thái: queued (Đang chờ), downloading (Đang tải), merging (Đang ghép),
 *   completed (Hoàn thành), paused (Đã tạm dừng), cancelled (Đã hủy), failed (Thất bại)
 * - Hỗ trợ Pause / Resume bằng HTTP Range (bytes=offset-), Retry có giới hạn, fallback mirror CDN,
 *   và tự làm mới URL playurl khi CDN link hết hạn (403/410)
 * - Hỗ trợ 3 chế độ: Video+Audio (DASH merge stream copy hoặc Progressive MP4), Chỉ Video, Chỉ Audio
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { DESKTOP_UA, BILIBILI_REFERER } = require('./constants');
const { buildCookieHeaderForUrl } = require('./cookieStore');
const { fetchPartQualities } = require('./bilibiliApi');
const { muxOrConvertStreams, probeMedia } = require('./ffmpegService');
const logger = require('./logger');

function sanitizeFilename(name, maxLen = 96) {
  return String(name || 'bilibili_video')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen) || 'bilibili_video';
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '--:--';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s`;
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

function uniqueTargetPath(dir, baseName, ext) {
  let candidate = path.join(dir, `${baseName}.${ext}`);
  let idx = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${baseName} (${idx}).${ext}`);
    idx++;
  }
  return candidate;
}

class DownloadManager extends EventEmitter {
  constructor({ storageStore, getCookieFn = () => '' }) {
    super();
    this.storage = storageStore;
    this.getCookieFn = getCookieFn;
    this.jobs = new Map(); // jobId -> jobRecord
    this.controllers = new Map(); // jobId -> { abortController, ffmpegCancel, userAction: 'pause'|'cancel'|null }
  }

  listJobs() {
    return Array.from(this.jobs.values())
      .map((j) => this._publicJobView(j))
      .reverse();
  }

  _publicJobView(j) {
    return {
      jobId: j.jobId,
      bvid: j.bvid,
      aid: j.aid,
      cid: j.cid,
      epId: j.epId,
      title: j.title,
      fileName: j.fileName,
      thumbnail: j.thumbnail,
      sourceUrl: j.sourceUrl,
      qualityLabel: j.qualityLabel,
      codecName: j.codecName,
      mode: j.mode,
      outputFormat: j.outputFormat,
      status: j.status,
      statusText: j.statusText,
      progress: j.progress,
      downloadedBytes: j.downloadedBytes,
      totalBytes: j.totalBytes,
      speedBytesPerSec: j.speedBytesPerSec,
      speedText: j.speedText,
      etaSeconds: j.etaSeconds,
      etaText: j.etaText,
      saveDir: j.saveDir,
      outputPath: j.outputPath,
      error: j.error,
      createdAt: j.createdAt,
      completedAt: j.completedAt
    };
  }

  _emitUpdate(job) {
    this.emit('update', this._publicJobView(job));
  }

  getRunningCount() {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'downloading' || j.status === 'merging') n++;
    }
    return n;
  }

  /**
   * Thêm 1 tác vụ mới vào hàng đợi.
   */
  enqueue(task) {
    const settings = this.storage.getSettings();
    const saveDir = task.saveDir || settings.downloadDir;
    fs.mkdirSync(saveDir, { recursive: true });

    const mode = task.mode || 'video_audio'; // 'video_audio' | 'video_only' | 'audio_only'
    const defaultExt = mode === 'audio_only' ? (task.audioStream?.ext === 'flac' ? 'flac' : 'm4a') : 'mp4';
    const outputFormat = (task.outputFormat || defaultExt).toLowerCase();

    const safeBase = sanitizeFilename(task.customFileName || `${task.title}${task.bvid ? ` [${task.bvid}]` : ''}`);
    const outputPath = uniqueTargetPath(saveDir, safeBase, outputFormat);
    const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const totalEst =
      (mode !== 'audio_only' ? Number(task.videoStream?.exactBytes || task.videoStream?.estimatedBytes || 0) : 0) +
      (mode !== 'video_only' && task.videoStream?.requiresMerge !== false && task.audioStream
        ? Number(task.audioStream.estimatedBytes || 0)
        : 0);

    const job = {
      jobId,
      bvid: task.bvid || null,
      aid: task.aid || null,
      cid: task.cid || null,
      epId: task.epId || null,
      author: task.author || '',
      duration: Number(task.duration) || 0,
      title: task.title || 'Bilibili Video',
      fileName: path.basename(outputPath),
      thumbnail: task.thumbnail || '',
      sourceUrl: task.sourceUrl || '',
      qualityLabel: task.videoStream?.qualityLabel || task.audioStream?.label || 'Tốt nhất',
      codecName: task.videoStream?.codecName || task.audioStream?.codecsRaw || '',
      mode,
      outputFormat,
      status: 'queued',
      statusText: 'Đang chờ trong hàng đợi...',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: totalEst,
      speedBytesPerSec: 0,
      speedText: '0 KB/s',
      etaSeconds: null,
      etaText: '--:--',
      saveDir,
      outputPath,
      videoPartPath: `${outputPath}.video.part`,
      audioPartPath: `${outputPath}.audio.part`,
      videoStream: task.videoStream || null,
      audioStream: task.audioStream || null,
      videoDownloaded: 0,
      audioDownloaded: 0,
      videoTotal: Number(task.videoStream?.exactBytes || 0),
      audioTotal: 0,
      metadataSnapshot: task.metadataSnapshot || null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null
    };

    this.jobs.set(jobId, job);
    this._emitUpdate(job);
    this._pumpQueue();
    return this._publicJobView(job);
  }

  _pumpQueue() {
    const maxConcurrent = this.storage.getSettings().maxConcurrent || 2;
    while (this.getRunningCount() < maxConcurrent) {
      const next = Array.from(this.jobs.values()).find((j) => j.status === 'queued');
      if (!next) break;
      this._runJob(next);
    }
  }

  pauseJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'queued') {
      job.status = 'paused';
      job.statusText = 'Đã tạm dừng';
      job.speedText = '0 KB/s';
      this._emitUpdate(job);
      return true;
    }
    if (job.status === 'downloading') {
      const ctrl = this.controllers.get(jobId);
      if (ctrl) {
        ctrl.userAction = 'pause';
        try { ctrl.abortController.abort(); } catch {}
      }
      return true;
    }
    return false;
  }

  resumeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'paused' || job.status === 'failed' || job.status === 'cancelled') {
      job.status = 'queued';
      job.statusText = 'Đang chờ tiếp tục...';
      job.error = null;
      this._emitUpdate(job);
      this._pumpQueue();
      return true;
    }
    return false;
  }

  retryJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'failed' || job.status === 'cancelled') {
      job.status = 'queued';
      job.statusText = 'Đang chờ thử lại...';
      job.error = null;
      this._emitUpdate(job);
      this._pumpQueue();
      return true;
    }
    return false;
  }

  cancelJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    const ctrl = this.controllers.get(jobId);
    if (ctrl) {
      ctrl.userAction = 'cancel';
      try { ctrl.abortController.abort(); } catch {}
      if (ctrl.ffmpegCancel && typeof ctrl.ffmpegCancel.kill === 'function') {
        try { ctrl.ffmpegCancel.kill(); } catch {}
      }
    }

    if (job.status === 'queued' || job.status === 'paused') {
      job.status = 'cancelled';
      job.statusText = 'Đã hủy';
      job.speedText = '0 KB/s';
      this._cleanupPartFiles(job);
      this._emitUpdate(job);
    }
    return true;
  }

  removeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.status === 'downloading' || job.status === 'merging') {
      this.cancelJob(jobId);
    }
    this.jobs.delete(jobId);
    return true;
  }

  _cleanupPartFiles(job) {
    for (const p of [job.videoPartPath, job.audioPartPath]) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  }

  /**
   * Làm mới URL luồng phát khi link CDN bị hết hạn (403/410) lúc Resume hoặc Retry.
   */
  async _refreshJobStreamUrls(job) {
    if (!job.cid || (!job.bvid && !job.aid && !job.epId)) return false;
    const cookie = this.getCookieFn() || '';
    logger.info('downloadManager', `Đang làm mới URL luồng cho ${job.bvid || job.epId} (cid=${job.cid})`);

    const fresh = await fetchPartQualities({
      bvid: job.bvid,
      aid: job.aid,
      cid: job.cid,
      epId: job.epId,
      durationSec: job.duration,
      cookie
    });

    if (job.videoStream) {
      if (job.videoStream.streamKind === 'progressive_mp4') {
        const matchProg =
          fresh.progressiveStreams.find((p) => p.qn === job.videoStream.qn) || fresh.progressiveStreams[0];
        if (matchProg) job.videoStream = matchProg;
      } else {
        const matchVid =
          fresh.videoStreams.find(
            (v) => v.qn === job.videoStream.qn && v.codecid === job.videoStream.codecid
          ) ||
          fresh.videoStreams.find((v) => v.qn === job.videoStream.qn) ||
          fresh.videoStreams[0];
        if (matchVid) job.videoStream = matchVid;
      }
    }

    if (job.audioStream) {
      const matchAud =
        fresh.audioStreams.find((a) => a.audioId === job.audioStream.audioId) || fresh.audioStreams[0];
      if (matchAud) job.audioStream = matchAud;
    }
    return true;
  }

  /**
   * Tải 1 luồng có hỗ trợ HTTP Range Resume, đổi mirror CDN và retry mạng chập chờn.
   */
  async _downloadSingleStreamWithResume(job, ctrl, streamObj, partPath, trackField) {
    const cookie = this.getCookieFn() || '';
    const maxRetries = 3;
    let urlList = [streamObj.url, ...(streamObj.backupUrls || [])].filter(Boolean);
    let urlIdx = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (ctrl.abortController.signal.aborted) {
        throw new Error(ctrl.userAction === 'pause' ? 'USER_PAUSED' : 'USER_CANCELLED');
      }

      const currentUrl = urlList[Math.min(urlIdx, urlList.length - 1)];
      let existingBytes = 0;
      if (fs.existsSync(partPath)) {
        existingBytes = fs.statSync(partPath).size;
      }

      const expectedTotal = trackField === 'video' ? job.videoTotal : job.audioTotal;
      if (expectedTotal > 0 && existingBytes >= expectedTotal) {
        if (trackField === 'video') job.videoDownloaded = expectedTotal;
        else job.audioDownloaded = expectedTotal;
        return;
      }

      const headers = {
        'User-Agent': DESKTOP_UA,
        Referer: job.sourceUrl || BILIBILI_REFERER,
        Accept: '*/*'
      };
      const ck = buildCookieHeaderForUrl(currentUrl, cookie);
      if (ck) headers.Cookie = ck;
      if (existingBytes > 0) {
        headers.Range = `bytes=${existingBytes}-`;
      }

      try {
        const res = await fetch(currentUrl, {
          headers,
          redirect: 'follow',
          signal: ctrl.abortController.signal
        });

        // URL hết hạn (403 / 410) -> làm mới URL từ API
        if ((res.status === 403 || res.status === 410) && attempt < maxRetries) {
          logger.warn('downloadManager', `Luồng trả HTTP ${res.status}, thử đổi mirror / làm mới link...`);
          if (urlIdx + 1 < urlList.length) {
            urlIdx++;
          } else {
            const refreshed = await this._refreshJobStreamUrls(job);
            if (refreshed) {
              const updatedStream = trackField === 'video' ? job.videoStream : job.audioStream;
              if (updatedStream?.url) {
                urlList = [updatedStream.url, ...(updatedStream.backupUrls || [])].filter(Boolean);
                urlIdx = 0;
              }
            }
          }
          continue;
        }

        // Range vượt kích thước (416) -> xóa file dở tải lại từ đầu
        if (res.status === 416) {
          if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
          existingBytes = 0;
          continue;
        }

        if (!res.ok && res.status !== 206) {
          throw new Error(`HTTP ${res.status} khi tải dữ liệu`);
        }

        const isPartial = res.status === 206;
        const contentLen = parseInt(res.headers.get('content-length') || '0', 10);
        let totalStreamBytes = 0;
        const contentRange = res.headers.get('content-range');
        if (contentRange) {
          const m = contentRange.match(/\/(\d+)$/);
          if (m) totalStreamBytes = parseInt(m[1], 10);
        }
        if (!totalStreamBytes && contentLen > 0) {
          totalStreamBytes = isPartial ? existingBytes + contentLen : contentLen;
        }

        if (trackField === 'video') {
          job.videoTotal = totalStreamBytes || job.videoTotal;
        } else {
          job.audioTotal = totalStreamBytes || job.audioTotal;
        }

        const writeFlags = isPartial && existingBytes > 0 ? 'a' : 'w';
        let written = isPartial ? existingBytes : 0;

        await new Promise((resolveStream, rejectStream) => {
          const ws = fs.createWriteStream(partPath, { flags: writeFlags });
          const reader = res.body.getReader();
          let lastSampleTime = Date.now();
          let lastSampleBytes = written;
          let lastEmitTime = 0;

          let settled = false;
          const safeReject = (err) => {
            if (settled) return;
            settled = true;
            ctrl.abortController.signal.removeEventListener('abort', onAbort);
            rejectStream(err);
          };

          const onAbort = () => {
            Promise.resolve()
              .then(() => reader.cancel())
              .catch(() => {});
            ws.end(() => {
              safeReject(new Error(ctrl.userAction === 'pause' ? 'USER_PAUSED' : 'USER_CANCELLED'));
            });
          };

          if (ctrl.abortController.signal.aborted) {
            return onAbort();
          }
          ctrl.abortController.signal.addEventListener('abort', onAbort, { once: true });

          ws.on('error', (err) => {
            safeReject(err);
          });

          (async () => {
            try {
              while (!settled) {
                const { done, value } = await reader.read();
                if (done || settled) break;
                if (value && value.length > 0) {
                  if (!ws.write(Buffer.from(value))) {
                    await new Promise((r) => ws.once('drain', r));
                  }
                  written += value.length;
                  if (trackField === 'video') job.videoDownloaded = written;
                  else job.audioDownloaded = written;

                  const now = Date.now();
                  if (now - lastEmitTime >= 250) {
                    const dt = Math.max((now - lastSampleTime) / 1000, 0.25);
                    const speed = (written - lastSampleBytes) / dt;
                    lastSampleTime = now;
                    lastSampleBytes = written;
                    lastEmitTime = now;

                    this._recalcProgress(job, speed);
                    this._emitUpdate(job);
                  }
                }
              }
              if (!settled) {
                ws.end(() => {
                  settled = true;
                  ctrl.abortController.signal.removeEventListener('abort', onAbort);
                  resolveStream();
                });
              }
            } catch (err) {
              if (!settled) {
                ws.destroy();
                safeReject(err);
              }
            }
          })();
        });

        // Kiểm tra dung lượng thực tế vừa ghi
        const finalPartSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
        if (totalStreamBytes > 0 && finalPartSize < totalStreamBytes) {
          throw new Error(`Luồng kết thúc sớm (${finalPartSize}/${totalStreamBytes} bytes)`);
        }
        return; // Thành công
      } catch (err) {
        if (err.message === 'USER_PAUSED' || err.message === 'USER_CANCELLED' || ctrl.abortController.signal.aborted) {
          throw new Error(ctrl.userAction === 'pause' ? 'USER_PAUSED' : 'USER_CANCELLED');
        }
        logger.warn('downloadManager', `Lỗi tải luồng ${trackField} (lần ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
        if (attempt >= maxRetries) throw err;
        if (urlIdx + 1 < urlList.length) urlIdx++;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }

  _recalcProgress(job, currentSpeedBps = 0) {
    const dl = (job.videoDownloaded || 0) + (job.audioDownloaded || 0);
    const estVideo = job.videoTotal || Number(job.videoStream?.estimatedBytes || 0);
    const estAudio = job.audioTotal || Number(job.audioStream?.estimatedBytes || 0);
    const tot =
      (job.mode !== 'audio_only' ? estVideo : 0) +
      (job.mode !== 'video_only' && job.videoStream?.requiresMerge !== false && job.audioStream ? estAudio : 0);

    job.downloadedBytes = dl;
    if (tot > 0) {
      job.totalBytes = Math.max(tot, dl);
      job.progress = Math.min(95, Math.round((dl / job.totalBytes) * 95));
    } else {
      job.progress = Math.min(90, job.progress + 1);
    }

    job.speedBytesPerSec = Math.max(0, currentSpeedBps);
    job.speedText = formatSpeed(job.speedBytesPerSec);
    if (job.totalBytes > dl && job.speedBytesPerSec > 0) {
      job.etaSeconds = (job.totalBytes - dl) / job.speedBytesPerSec;
      job.etaText = formatEta(job.etaSeconds);
    } else {
      job.etaSeconds = null;
      job.etaText = '--:--';
    }
  }

  async _runJob(job) {
    const abortController = new AbortController();
    const ffmpegCancel = { kill: null };
    const ctrl = { abortController, ffmpegCancel, userAction: null };
    this.controllers.set(job.jobId, ctrl);

    job.status = 'downloading';
    job.statusText = 'Đang tải luồng dữ liệu...';
    job.error = null;
    this._emitUpdate(job);

    try {
      const needVideo = job.mode !== 'audio_only';
      const isProgressive = job.videoStream && !job.videoStream.requiresMerge && job.videoStream.hasAudio;
      const needAudio = job.mode === 'audio_only' || (job.mode === 'video_audio' && !isProgressive && Boolean(job.audioStream));

      if (needVideo) {
        if (!job.videoStream?.url) throw new Error('Thiếu URL luồng video hợp lệ.');
        job.statusText = 'Đang tải luồng hình ảnh...';
        this._emitUpdate(job);
        await this._downloadSingleStreamWithResume(job, ctrl, job.videoStream, job.videoPartPath, 'video');
      }

      if (needAudio) {
        if (!job.audioStream?.url) throw new Error('Thiếu URL luồng âm thanh hợp lệ.');
        job.statusText = 'Đang tải luồng âm thanh...';
        this._emitUpdate(job);
        await this._downloadSingleStreamWithResume(job, ctrl, job.audioStream, job.audioPartPath, 'audio');
      }

      // Kiểm tra lại trạng thái hủy/tạm dừng trước khi ghép
      if (ctrl.abortController.signal.aborted) {
        throw new Error(ctrl.userAction === 'pause' ? 'USER_PAUSED' : 'USER_CANCELLED');
      }

      // Chuyển sang bước FFmpeg ghép / xác minh
      job.status = 'merging';
      job.progress = 96;
      job.speedText = 'Đang xử lý FFmpeg...';
      job.etaText = '00:02';

      if (isProgressive && job.mode === 'video_audio' && job.outputFormat === 'mp4') {
        // Progressive MP4 gộp sẵn: xác minh bằng probeMedia, nếu đạt chuẩn thì đổi tên thẳng không cần re-mux!
        job.statusText = 'Đang xác minh file MP4...';
        this._emitUpdate(job);
        const probe = await probeMedia(job.videoPartPath, { verifyDecode: true });
        if (probe.valid && probe.hasVideo) {
          if (fs.existsSync(job.outputPath)) fs.unlinkSync(job.outputPath);
          fs.renameSync(job.videoPartPath, job.outputPath);
        } else {
          // Chạy remux lại nếu MP4 lỗi nhỏ
          await muxOrConvertStreams({
            videoPath: job.videoPartPath,
            outputPath: job.outputPath,
            outputFormat: 'mp4',
            mode: 'video_only',
            duration: job.duration,
            cancelHandle: ffmpegCancel
          });
          this._cleanupPartFiles(job);
        }
      } else {
        job.statusText =
          job.mode === 'audio_only'
            ? 'Đang đóng gói âm thanh (FFmpeg)...'
            : 'Đang ghép video + audio không giảm chất lượng (FFmpeg)...';
        this._emitUpdate(job);

        await muxOrConvertStreams({
          videoPath: needVideo ? job.videoPartPath : null,
          audioPath: needAudio ? job.audioPartPath : null,
          outputPath: job.outputPath,
          outputFormat: job.outputFormat,
          mode: job.mode,
          videoCodecKey: job.videoStream?.codecKey || 'avc',
          duration: job.duration,
          onProgress: (pct) => {
            job.progress = Math.max(96, Math.min(99, 96 + Math.round(pct * 0.03)));
            this._emitUpdate(job);
          },
          cancelHandle: ffmpegCancel
        });
        this._cleanupPartFiles(job);
      }

      const stat = fs.statSync(job.outputPath);
      job.totalBytes = stat.size;
      job.downloadedBytes = stat.size;
      job.progress = 100;
      job.status = 'completed';
      job.statusText = 'Hoàn thành';
      job.speedText = 'Hoàn tất';
      job.etaText = '00:00';
      job.completedAt = new Date().toISOString();

      // Lưu file metadata an toàn bên cạnh nếu bật tùy chọn (không bao giờ chứa cookie)
      if (this.storage.getSettings().saveMetadataJson && job.metadataSnapshot) {
        try {
          const metaPath = job.outputPath.replace(/\.[^.]+$/, '.metadata.json');
          const safeMeta = logger.sanitizeObject(job.metadataSnapshot);
          fs.writeFileSync(metaPath, JSON.stringify(safeMeta, null, 2), 'utf8');
        } catch {}
      }

      this.storage.addHistoryItem({
        bvid: job.bvid,
        title: job.title,
        author: job.author,
        thumbnail: job.thumbnail,
        qualityLabel: job.qualityLabel,
        codecName: job.codecName,
        mode: job.mode,
        outputFormat: job.outputFormat,
        fileSize: stat.size,
        duration: job.duration,
        outputPath: job.outputPath,
        saveDir: job.saveDir,
        sourceUrl: job.sourceUrl,
        downloadedAt: job.completedAt
      });

      this._emitUpdate(job);
    } catch (err) {
      if (err.message === 'USER_PAUSED' || ctrl.userAction === 'pause') {
        job.status = 'paused';
        job.statusText = 'Đã tạm dừng (giữ dữ liệu tải dở)';
        job.speedText = '0 KB/s';
        job.etaText = '--:--';
        this._emitUpdate(job);
      } else if (err.message === 'USER_CANCELLED' || ctrl.userAction === 'cancel') {
        job.status = 'cancelled';
        job.statusText = 'Đã hủy';
        job.speedText = '0 KB/s';
        job.etaText = '--:--';
        this._cleanupPartFiles(job);
        this._emitUpdate(job);
      } else {
        logger.error('downloadManager', `Tác vụ ${job.jobId} thất bại: ${err.message}`);
        job.status = 'failed';
        job.statusText = 'Thất bại';
        job.error = err.message;
        job.speedText = '0 KB/s';
        job.etaText = '--:--';
        this._emitUpdate(job);
      }
    } finally {
      this.controllers.delete(job.jobId);
      this._pumpQueue();
    }
  }
}

module.exports = {
  DownloadManager,
  sanitizeFilename,
  formatEta,
  formatSpeed
};
