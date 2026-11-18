const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { StorageStore } = require('../core/storageStore');
const { DownloadManager } = require('../core/downloadManager');
const { getFfmpegPath, probeMedia } = require('../core/ffmpegService');

function generateTestMediaFiles(tmpDir) {
  const ffmpeg = getFfmpegPath();
  const videoM4s = path.join(tmpDir, 'src_video.mp4');
  const audioM4a = path.join(tmpDir, 'src_audio.m4a');

  // Tạo video mẫu 2 giây (H.264 320x240) & audio mẫu 2 giây (AAC) bằng FFmpeg thật
  const r1 = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoM4s
  ]);
  if (r1.status !== 0) throw new Error('Không tạo được video test bằng FFmpeg: ' + r1.stderr?.toString());

  const r2 = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:a', 'aac', '-b:a', '128k', audioM4a
  ]);
  if (r2.status !== 0) throw new Error('Không tạo được audio test bằng FFmpeg: ' + r2.stderr?.toString());

  return { videoM4s, audioM4a };
}

function startRangeTestServer({ videoBuf, audioBuf }) {
  let dropFirstAttempt = true;
  let slowServe = false;

  const server = http.createServer((req, res) => {
    if (req.url === '/expired') {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const buf = req.url.startsWith('/audio') ? audioBuf : videoBuf;
    const total = buf.length;
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = total - 1;
    let status = 200;

    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        start = parseInt(m[1], 10);
        end = m[2] ? parseInt(m[2], 10) : total - 1;
        status = 206;
      }
    }

    if (start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    const chunk = buf.subarray(start, end + 1);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunk.length)
    };
    if (status === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }

    // Giả lập rớt mạng giữa chừng cho lần thử đầu của /video-drop
    if (req.url === '/video-drop' && dropFirstAttempt) {
      dropFirstAttempt = false;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(total), 'Accept-Ranges': 'bytes' });
      res.write(chunk.subarray(0, Math.floor(chunk.length / 2)));
      setTimeout(() => res.destroy(), 30);
      return;
    }

    if (req.url.startsWith('/video-slow') || slowServe) {
      res.writeHead(status, headers);
      const mid = Math.floor(chunk.length / 3);
      res.write(chunk.subarray(0, mid));
      setTimeout(() => {
        if (!res.destroyed) {
          res.end(chunk.subarray(mid));
        }
      }, 250);
      return;
    }

    res.writeHead(status, headers);
    res.end(chunk);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function waitJobDone(dm, jobId, targetStatuses = ['completed', 'failed', 'cancelled', 'paused']) {
  return new Promise((resolve) => {
    const check = () => {
      const j = dm.listJobs().find((x) => x.jobId === jobId);
      if (j && targetStatuses.includes(j.status)) {
        dm.off('update', onUpdate);
        resolve(j);
      }
    };
    const onUpdate = (j) => {
      if (j.jobId === jobId && targetStatuses.includes(j.status)) {
        dm.off('update', onUpdate);
        resolve(j);
      }
    };
    dm.on('update', onUpdate);
    check();
  });
}

async function run() {
  console.log('=== [TEST] Stage 8 & 9: Download Queue, Pause/Resume, Retry, FFmpeg Merge ===');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bilidl-test-'));
  const dlDir = path.join(tmpRoot, 'downloads');
  const { videoM4s, audioM4a } = generateTestMediaFiles(tmpRoot);
  const videoBuf = fs.readFileSync(videoM4s);
  const audioBuf = fs.readFileSync(audioM4a);

  const { server, port } = await startRangeTestServer({ videoBuf, audioBuf });
  const base = `http://127.0.0.1:${port}`;

  try {
    const storage = new StorageStore(path.join(tmpRoot, 'appdata'));
    storage.updateSettings({ downloadDir: dlDir, maxConcurrent: 2, saveMetadataJson: true });
    const dm = new DownloadManager({ storageStore: storage, getCookieFn: () => 'SESSDATA=secret_cookie_must_not_leak' });

    // 1. Tải DASH tách luồng (Video + Audio) và ghép stream copy FFmpeg + kiểm tra backup mirror khi primary 403
    const job1 = dm.enqueue({
      bvid: 'BV1TEST00001',
      cid: '10001',
      title: 'Test DASH Merge',
      duration: 2,
      videoStream: {
        qn: 80,
        qualityLabel: '1080P',
        codecKey: 'avc',
        codecName: 'H.264 (AVC)',
        requiresMerge: true,
        hasAudio: false,
        estimatedBytes: videoBuf.length,
        url: `${base}/expired`,
        backupUrls: [`${base}/video`]
      },
      audioStream: {
        audioId: 30280,
        label: '192 Kbps AAC',
        estimatedBytes: audioBuf.length,
        url: `${base}/audio`
      },
      metadataSnapshot: { title: 'Test DASH Merge', cookie: 'SESSDATA=secret_cookie_must_not_leak' }
    });
    const res1 = await waitJobDone(dm, job1.jobId);
    assert.strictEqual(res1.status, 'completed', `Job1 failed: ${res1.error}`);
    const probe1 = await probeMedia(res1.outputPath, { verifyDecode: true });
    assert.strictEqual(probe1.valid, true);
    assert.strictEqual(probe1.hasVideo, true);
    assert.strictEqual(probe1.hasAudio, true);
    assert.strictEqual(probe1.vcodec, 'h264');

    // Kiểm tra file metadata không rò rỉ cookie
    const meta1 = fs.readFileSync(res1.outputPath.replace(/\.mp4$/, '.metadata.json'), 'utf8');
    assert.ok(!meta1.includes('secret_cookie_must_not_leak'));

    // 2. Test rớt mạng giữa chừng -> tự Retry bằng HTTP Range
    const jobDrop = dm.enqueue({
      bvid: 'BV1DROP00002',
      title: 'Test Network Drop Retry',
      duration: 2,
      videoStream: {
        qn: 80,
        qualityLabel: '1080P',
        codecKey: 'avc',
        requiresMerge: true,
        hasAudio: false,
        url: `${base}/video-drop`
      },
      audioStream: { audioId: 30280, url: `${base}/audio` }
    });
    const resDrop = await waitJobDone(dm, jobDrop.jobId);
    assert.strictEqual(resDrop.status, 'completed', `JobDrop failed: ${resDrop.error}`);

    // 3. Test Pause -> Resume
    const jobPause = dm.enqueue({
      bvid: 'BV1PAUSE0003',
      title: 'Test Pause Resume',
      duration: 2,
      videoStream: {
        qn: 80,
        qualityLabel: '1080P',
        codecKey: 'avc',
        requiresMerge: true,
        hasAudio: false,
        url: `${base}/video-slow`
      },
      audioStream: { audioId: 30280, url: `${base}/audio` }
    });
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(dm.pauseJob(jobPause.jobId), true);
    const pausedState = await waitJobDone(dm, jobPause.jobId, ['paused']);
    assert.strictEqual(pausedState.status, 'paused');
    assert.strictEqual(dm.resumeJob(jobPause.jobId), true);
    const resumedDone = await waitJobDone(dm, jobPause.jobId);
    assert.strictEqual(resumedDone.status, 'completed', `JobPause resume failed: ${resumedDone.error}`);

    // 4. Test Video-only & Audio-only (MP3)
    const jobVidOnly = dm.enqueue({
      bvid: 'BV1VIDONLY04',
      title: 'Test Video Only',
      mode: 'video_only',
      outputFormat: 'mp4',
      duration: 2,
      videoStream: { qn: 80, qualityLabel: '1080P', codecKey: 'avc', requiresMerge: true, hasAudio: false, url: `${base}/video` }
    });
    const resVidOnly = await waitJobDone(dm, jobVidOnly.jobId);
    assert.strictEqual(resVidOnly.status, 'completed');
    const probeVidOnly = await probeMedia(resVidOnly.outputPath, { verifyDecode: true });
    assert.strictEqual(probeVidOnly.hasVideo, true);
    assert.strictEqual(probeVidOnly.hasAudio, false);

    const jobAudOnly = dm.enqueue({
      bvid: 'BV1AUDONLY05',
      title: 'Test Audio Only MP3',
      mode: 'audio_only',
      outputFormat: 'mp3',
      duration: 2,
      audioStream: { audioId: 30280, label: '192 Kbps AAC', ext: 'm4a', url: `${base}/audio` }
    });
    const resAudOnly = await waitJobDone(dm, jobAudOnly.jobId);
    assert.strictEqual(resAudOnly.status, 'completed', `Audio-only failed: ${resAudOnly.error}`);
    const probeAudOnly = await probeMedia(resAudOnly.outputPath, { verifyDecode: true });
    assert.strictEqual(probeAudOnly.hasVideo, false);
    assert.strictEqual(probeAudOnly.hasAudio, true);
    assert.strictEqual(probeAudOnly.acodec, 'mp3');

    // 5. Kiểm tra lịch sử tải đã lưu đủ 5 mục
    const history = storage.getHistory();
    assert.strictEqual(history.length, 5);

    console.log('✅ Stage 8 & 9 Download, Pause/Resume, Retry & FFmpeg tests passed!');
  } finally {
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
