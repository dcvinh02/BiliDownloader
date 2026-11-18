const assert = require('assert');
const {
  isBilibiliHost,
  extractUrlOrIdFromInput,
  classifyBilibiliUrl,
  parseBilibiliInput
} = require('../core/urlParser');

async function run() {
  console.log('=== [TEST] Stage 5: URL Parser & Classifier ===');

  // 1. Chỉ chấp nhận Bilibili
  assert.strictEqual(isBilibiliHost('www.bilibili.com'), true);
  assert.strictEqual(isBilibiliHost('b23.tv'), true);
  assert.strictEqual(isBilibiliHost('space.bilibili.com'), true);
  assert.strictEqual(isBilibiliHost('www.youtube.com'), false);
  assert.strictEqual(isBilibiliHost('www.douyin.com'), false);

  // 2. Tách URL từ văn bản chia sẻ & iframe & mã BV/AV trần
  const shareText = '【测试视频】 https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&share_source=copy_web 点击观看';
  assert.strictEqual(
    extractUrlOrIdFromInput(shareText),
    'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&share_source=copy_web'
  );
  assert.strictEqual(extractUrlOrIdFromInput('BV1GJ411x7h7'), 'https://www.bilibili.com/video/BV1GJ411x7h7');
  assert.strictEqual(extractUrlOrIdFromInput('av170001'), 'https://www.bilibili.com/video/av170001');
  assert.strictEqual(
    extractUrlOrIdFromInput('<iframe src="//player.bilibili.com/player.html?bvid=BV1GJ411x7h7"></iframe>'),
    'https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7'
  );

  // 3. Phân loại video BV có ?p=2 (bảo toàn phần)
  const vBv = classifyBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&spm_id_from=333.999');
  assert.strictEqual(vBv.contentType, 'video');
  assert.strictEqual(vBv.bvid, 'BV1GJ411x7h7');
  assert.strictEqual(vBv.pageNum, 2);
  assert.strictEqual(vBv.cleanUrl, 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2');

  // 4. Phân loại AV
  const vAv = classifyBilibiliUrl('https://www.bilibili.com/video/av170001?p=1');
  assert.strictEqual(vAv.contentType, 'video');
  assert.strictEqual(vAv.aid, '170001');
  assert.strictEqual(vAv.videoId, 'av170001');

  // 5. Phân loại Bangumi PGC
  const pgcEp = classifyBilibiliUrl('https://www.bilibili.com/bangumi/play/ep123456?from_spmid=666');
  assert.strictEqual(pgcEp.contentType, 'pgc');
  assert.strictEqual(pgcEp.epId, '123456');

  const pgcSs = classifyBilibiliUrl('https://www.bilibili.com/bangumi/play/ss38881');
  assert.strictEqual(pgcSs.contentType, 'pgc');
  assert.strictEqual(pgcSs.seasonId, '38881');

  // 6. Phân loại Space & Collection/Series
  const sp = classifyBilibiliUrl('https://space.bilibili.com/546195/video');
  assert.strictEqual(sp.contentType, 'space');
  assert.strictEqual(sp.mid, '546195');

  const col = classifyBilibiliUrl('https://space.bilibili.com/546195/lists/12345?type=season');
  assert.strictEqual(col.contentType, 'collection');
  assert.strictEqual(col.collectionKind, 'season');
  assert.strictEqual(col.seasonId, '12345');

  // 7. Từ chối nền tảng khác và URL sai
  assert.throws(() => classifyBilibiliUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /chỉ hỗ trợ duy nhất nền tảng Bilibili/i);
  assert.throws(() => classifyBilibiliUrl('https://www.tiktok.com/@user/video/123'), /chỉ hỗ trợ duy nhất nền tảng Bilibili/i);
  await assert.rejects(() => parseBilibiliInput('not-a-url-or-id'), /không chứa URL Bilibili hợp lệ/i);

  // 8. Parse full input BV
  const parsedBv = await parseBilibiliInput('BV1GJ411x7h7');
  assert.strictEqual(parsedBv.bvid, 'BV1GJ411x7h7');
  assert.strictEqual(parsedBv.contentType, 'video');

  console.log('✅ Stage 5 URL Parser tests passed!');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
