const assert = require('assert');
const {
  normalizePlayUrlStreams,
  analyzeBilibiliUrl
} = require('../core/bilibiliApi');

async function run() {
  console.log('=== [TEST] Stage 6 & 7: Metadata & Real Quality Extraction ===');

  // 1. Unit test chuẩn hóa danh sách chất lượng thực tế từ Bilibili DASH + HTML5 durl
  const mockDashPlayData = {
    quality: 80,
    accept_quality: [120, 116, 80, 64, 32, 16],
    accept_description: ['4K 超清', '1080P60', '1080P 高清', '720P 高清', '480P 清晰', '360P 流畅'],
    support_formats: [
      { quality: 120, new_description: '4K 超清' },
      { quality: 116, new_description: '1080P60' },
      { quality: 80, new_description: '1080P 高清' },
      { quality: 64, new_description: '720P 高清' },
      { quality: 32, new_description: '480P 清晰' },
      { quality: 16, new_description: '360P 流畅' }
    ],
    dash: {
      video: [
        { id: 80, codecid: 7, width: 1920, height: 1080, frameRate: '30.000', bandwidth: 3200000, codecs: 'avc1.640032', baseUrl: 'https://upos.bilivideo.com/v80_avc.m4s' },
        { id: 80, codecid: 12, width: 1920, height: 1080, frameRate: '30.000', bandwidth: 2100000, codecs: 'hev1.1.6.L150', baseUrl: 'https://upos.bilivideo.com/v80_hevc.m4s' },
        { id: 64, codecid: 7, width: 1280, height: 720, frameRate: '30.000', bandwidth: 1500000, codecs: 'avc1.64001f', baseUrl: 'https://upos.bilivideo.com/v64_avc.m4s' },
        { id: 32, codecid: 7, width: 852, height: 480, frameRate: '30.000', bandwidth: 800000, codecs: 'avc1.64001e', baseUrl: 'https://upos.bilivideo.com/v32_avc.m4s' }
      ],
      audio: [
        { id: 30280, bandwidth: 192000, codecs: 'mp4a.40.2', baseUrl: 'https://upos.bilivideo.com/a30280.m4s' },
        { id: 30216, bandwidth: 64000, codecs: 'mp4a.40.2', baseUrl: 'https://upos.bilivideo.com/a30216.m4s' }
      ]
    }
  };

  const norm = normalizePlayUrlStreams(mockDashPlayData, 120);
  assert.strictEqual(norm.videoStreams.length, 4);
  assert.strictEqual(norm.videoStreams[0].qn, 80);
  assert.strictEqual(norm.videoStreams[0].codecKey, 'avc');
  assert.strictEqual(norm.videoStreams[0].fps, 30);
  assert.strictEqual(norm.videoStreams[0].bitrateKbps, 3200);
  assert.strictEqual(norm.videoStreams[0].estimatedBytes, Math.round((3200000 * 120) / 8));

  assert.strictEqual(norm.audioStreams.length, 2);
  assert.strictEqual(norm.audioStreams[0].audioId, 30280);

  // Chất lượng VIP (120 4K, 116 1080P60) và 16 chưa có trong dash.video -> phải nằm ở lockedQualities, KHÔNG trộn vào videoStreams
  assert.strictEqual(norm.lockedQualities.some((q) => q.qn === 120), true);
  assert.strictEqual(norm.videoStreams.some((v) => v.qn === 120), false);

  // 2. Live API test (nếu có mạng)
  if (process.env.SKIP_LIVE_BILIBILI !== '1') {
    const res = await analyzeBilibiliUrl('https://www.bilibili.com/video/BV1uv411q7Mv');
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.data.bvid, 'BV1uv411q7Mv');
    assert.ok(res.data.title && res.data.title.length > 0);
    assert.ok(res.data.cid);
    assert.ok(res.data.author);
    assert.ok(res.data.authorMid);
    assert.ok(res.data.cover.startsWith('https://'));
    assert.ok(res.data.duration > 0);
    assert.ok(res.data.streams.videoStreams.length > 0 || res.data.streams.progressiveStreams.length > 0);
    console.log(
      `   [LIVE 1] "${res.data.title}" | Tác giả: ${res.data.author} (UID ${res.data.authorMid}) | ` +
      `DASH Video: ${res.data.streams.videoStreams.length}, Audio: ${res.data.streams.audioStreams.length}, MP4: ${res.data.streams.progressiveStreams.length}`
    );

    // Multi-part video (10 phần)
    const multi = await analyzeBilibiliUrl('https://www.bilibili.com/video/BV17x411w7KC?p=2');
    assert.strictEqual(multi.success, true);
    assert.ok(multi.data.pages.length >= 2);
    assert.strictEqual(multi.data.selectedPageNum, 2);
    console.log(`   [LIVE 2 - Multi-part] "${multi.data.title}" | Số phần: ${multi.data.pages.length} | Đang chọn: P${multi.data.selectedPageNum}`);

    // URL dạng AV (dùng aid của chính video trên để đối chiếu kết quả giống hệt BV)
    const avRes = await analyzeBilibiliUrl(`https://www.bilibili.com/video/av${multi.data.aid}`);
    assert.strictEqual(avRes.success, true);
    assert.strictEqual(avRes.data.bvid, multi.data.bvid);
    console.log(`   [LIVE 3 - AV URL] av${multi.data.aid} -> khớp ${avRes.data.bvid}`);

    // Video không tồn tại (-404)
    await assert.rejects(
      () => analyzeBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7'),
      /không tồn tại|đã bị xóa/i
    );
    console.log('   [LIVE 4 - 404] Xử lý đúng video không tồn tại (-404)');
  }

  console.log('✅ Stage 6 & 7 Metadata & Quality tests passed!');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
