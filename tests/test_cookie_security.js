const assert = require('assert');
const fs = require('fs');
const {
  isBilibiliCookieAllowedUrl,
  validateAndNormalizeCookie,
  buildCookieHeaderForUrl,
  createTempNetscapeCookieFile
} = require('../core/cookieStore');
const logger = require('../core/logger');

async function run() {
  console.log('=== [TEST] Cookie Security & Logger Redaction ===');

  // 1. Cách ly domain
  assert.strictEqual(isBilibiliCookieAllowedUrl('https://api.bilibili.com/x/web-interface/view'), true);
  assert.strictEqual(isBilibiliCookieAllowedUrl('https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/abc.m4s'), true);
  assert.strictEqual(isBilibiliCookieAllowedUrl('https://example.com/steal'), false);
  assert.strictEqual(isBilibiliCookieAllowedUrl('https://bilibili.com.evil.com/'), false);

  // 2. Parse Header, Netscape, JSON
  const ckHeader = 'Cookie: SESSDATA=secret_sess_123; bili_jct=csrf_456; DedeUserID=998877';
  const norm1 = validateAndNormalizeCookie(ckHeader);
  assert.strictEqual(norm1.valid, true);
  assert.strictEqual(norm1.hasSessData, true);
  assert.strictEqual(norm1.dedeUserId, '998877');

  const ckJson = JSON.stringify([
    { name: 'SESSDATA', value: 'json_sess_abc', domain: '.bilibili.com', httpOnly: true },
    { name: 'evil_other', value: '123', domain: '.google.com' }
  ]);
  const norm2 = validateAndNormalizeCookie(ckJson);
  assert.strictEqual(norm2.valid, true);
  assert.strictEqual(norm2.cookieCount, 1); // Đã lọc bỏ cookie không thuộc bilibili

  // 3. Không gửi cookie cho bên thứ ba
  assert.strictEqual(buildCookieHeaderForUrl('https://evil.com/', ckHeader), '');
  assert.ok(buildCookieHeaderForUrl('https://api.bilibili.com/x/web-interface/nav', ckHeader).includes('SESSDATA=secret_sess_123'));

  // 4. Temp Netscape file quyền 0600
  const tmpPath = createTempNetscapeCookieFile(ckHeader);
  assert.ok(tmpPath && fs.existsSync(tmpPath));
  const content = fs.readFileSync(tmpPath, 'utf8');
  assert.ok(content.includes('# Netscape HTTP Cookie File'));
  assert.ok(content.includes('SESSDATA\tsecret_sess_123'));
  fs.unlinkSync(tmpPath);

  // 5. Che cookie trong log
  const logLine = logger.info('test', 'Header Cookie: SESSDATA=my_secret_value; bili_jct=abc999', {
    cookie: 'SESSDATA=my_secret_value',
    safeField: 'hello'
  });
  assert.ok(!logLine.includes('my_secret_value'));
  assert.ok(!logLine.includes('abc999'));
  assert.ok(logLine.includes('[REDACTED]'));

  console.log('✅ Cookie Security & Redaction tests passed!');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
