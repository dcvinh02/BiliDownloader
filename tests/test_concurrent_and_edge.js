const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { getMixinKey, signWbiParams } = require('../core/wbiSigner');
const { StorageStore } = require('../core/storageStore');
const { DownloadManager } = require('../core/downloadManager');
const { analyzeBilibiliUrl } = require('../core/bilibiliApi');
const { getFfmpegPath, probeMedia } = require('../core/ffmpegService');

async function testWbiOfficialVector() {
  // Vector chuẩn kiểm chứng thuật toán WBI (img_key + sub_key -> mixinKey -> MD5 w_rid)
  const imgKey = '7cd084941338484aae1ad9425b84077c';
  const subKey = '4932caff0ff746eab6f01bf08b70ac45';
  const mixin = getMixinKey(imgKey + subKey);
  assert.strictEqual(mixin, 'ea1db124af3c7062474693fa704f4ff8');

  const query = signWbiParams({ foo: '114', bar: '514', baz: 1919810 }, imgKey, subKey, 1702204169);
  assert.strictEqual(query, 'bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee');
}

async function testConcurrentQueueLimit() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bilidl-conc-'));
  const ffmpeg = getFfmpegPath();
  const videoFile = path.join(tmpRoot, 'v.mp4');
  spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=15', '-c:v', 'libx264', videoFile]);
  const buf = fs.readFileSync(videoFile);

  let currentActive = 0;
  let peakActive = 0;
  const server = http.createServer((req, res) => {
    currentActive++;
    peakActive = Math.max(peakActive, currentActive);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length) });
    setTimeout(() => {
      res.end(buf);
      currentActive--;
    }, 150);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const storage = new StorageStore(path.join(tmpRoot, 'app'));
    storage.updateSettings({ downloadDir: path.join(tmpRoot, 'dl'), maxConcurrent: 2 });
    const dm = new DownloadManager({ storageStore: storage });

    const jobs = [];
    for (let i = 1; i <= 4; i++) {
      jobs.push(
        dm.enqueue({
          bvid: `BV1CONC000${i}`,
          title: `Concurrent Video ${i}`,
          duration: 1,
          videoStream: {
            qn: 64,
            qualityLabel: '720P',
            codecKey: 'avc',
            requiresMerge: false,
            hasAudio: true,
            exactBytes: buf.length,
            url: `http://127.0.0.1:${port}/v${i}`
          }
        })
      );
    }

    await new Promise((resolve) => {
      const check = () => {
        const list = dm.listJobs();
        if (list.length === 4 && list.every((j) => j.status === 'completed')) {
          dm.off('update', check);
          resolve();
        }
      };
      dm.on('update', check);
      check();
    });

    assert.ok(peakActive <= 2, `Quá giới hạn concurrent: peak=${peakActive} > 2`);
    assert.strictEqual(dm.listJobs().filter((j) => j.status === 'completed').length, 4);
  } finally {
    server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testLiveRealBilibiliDashDownload() {
  if (process.env.SKIP_LIVE_BILIBILI === '1') return;
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bilidl-live-'));
  try {
    const res = await analyzeBilibiliUrl('https://www.bilibili.com/video/BV17x411w7KC?p=1');
    const d = res.data;
    assert.ok(d.streams.videoStreams.length > 0, 'Thiếu luồng DASH video');
    assert.ok(d.streams.audioStreams.length > 0, 'Thiếu luồng DASH audio');

    // Chọn luồng DASH 360P HEVC (~3.8MB) + audio thấp nhất để test ghép FFmpeg thật nhanh & chính xác
    const dashVid = [...d.streams.videoStreams].sort((a, b) => (a.estimatedBytes || 9e9) - (b.estimatedBytes || 9e9))[0];
    const dashAud = [...d.streams.audioStreams].sort((a, b) => (a.estimatedBytes || 9e9) - (b.estimatedBytes || 9e9))[0];

    const storage = new StorageStore(path.join(tmpRoot, 'app'));
    storage.updateSettings({ downloadDir: path.join(tmpRoot, 'dl'), maxConcurrent: 1 });
    const dm = new DownloadManager({ storageStore: storage });

    const job = dm.enqueue({
      bvid: d.bvid,
      aid: d.aid,
      cid: d.cid,
      title: d.title,
      author: d.author,
      duration: d.duration,
      thumbnail: d.cover,
      sourceUrl: d.cleanUrl,
      mode: 'video_audio',
      outputFormat: 'mp4',
      videoStream: dashVid,
      audioStream: dashAud
    });

    const finished = await new Promise((resolve) => {
      const onUp = (j) => {
        if (j.jobId === job.jobId && ['completed', 'failed', 'cancelled'].includes(j.status)) {
          dm.off('update', onUp);
          resolve(j);
        }
      };
      dm.on('update', onUp);
    });

    assert.strictEqual(finished.status, 'completed', `Live Bilibili DASH download failed: ${finished.error}`);
    const probe = await probeMedia(finished.outputPath, { verifyDecode: true });
    assert.strictEqual(probe.valid, true);
    assert.strictEqual(probe.hasVideo, true);
    assert.strictEqual(probe.hasAudio, true);
    console.log(
      `   [LIVE E2E DOWNLOAD] Thành công! File: ${(probe.fileSize / 1024 / 1024).toFixed(2)} MB | ` +
      `Video: ${probe.vcodec} (${probe.width}x${probe.height}) | Audio: ${probe.acodec} | Duration: ${probe.duration.toFixed(1)}s`
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function run() {
  console.log('=== [TEST] Stage 12: WBI Signing, Concurrent Queue & Live E2E ===');
  await testWbiOfficialVector();
  await testConcurrentQueueLimit();
  await testLiveRealBilibiliDashDownload();
  console.log('✅ Stage 12 Concurrent & E2E tests passed!');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
