/**
 * Quản lý & xác thực Cookie Bilibili an toàn:
 * - Hỗ trợ cả 3 định dạng nhập vào: Header ("SESSDATA=...; bili_jct=..."), Netscape cookies.txt, JSON array/object.
 * - Cách ly tên miền nghiêm ngặt: chỉ gửi cookie tới *.bilibili.com, *.bilivideo.com, *.b23.tv.
 * - Không bao giờ xuất hoặc ghi cookie thật vào log hay file metadata video.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { ALLOWED_COOKIE_DOMAINS, BILIBILI_AUTH_COOKIE_KEYS } = require('./constants');

function isBilibiliCookieAllowedUrl(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return false;
  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    return ALLOWED_COOKIE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

function parseCookiePairs(rawCookie) {
  const pairs = [];
  const seen = new Set();
  const raw = String(rawCookie || '').trim();
  if (!raw) return pairs;

  const pushPair = (name, value, domain = '.bilibili.com', httpOnly = false, expires = 0) => {
    const k = String(name || '').trim();
    const v = String(value ?? '').trim();
    if (!k || /[\r\n\t]/.test(k) || /[\r\n\t]/.test(v)) return;
    const keyLower = k.toLowerCase();
    if (seen.has(keyLower)) return;
    seen.add(keyLower);
    pairs.push({ name: k, value: v, domain, httpOnly, expires });
  };

  // 1. JSON array hoặc { cookies: [...] } (từ extension Cookie-Editor / EditThisCookie)
  if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cookies) ? parsed.cookies : null;
      if (arr) {
        for (const item of arr) {
          if (!item || !item.name) continue;
          const dom = item.domain ? String(item.domain) : '.bilibili.com';
          if (dom && !dom.toLowerCase().includes('bilibili') && !dom.toLowerCase().includes('b23.tv')) continue;
          pushPair(item.name, item.value ?? '', dom.startsWith('.') ? dom : `.${dom}`, Boolean(item.httpOnly), Number(item.expirationDate) || 0);
        }
        return pairs;
      }
    } catch {}
  }

  // 2. Netscape cookies.txt
  if (raw.includes('# Netscape HTTP Cookie File') || raw.includes('\t')) {
    const lines = raw.split(/\r?\n/);
    for (const ln of lines) {
      const trimmed = ln.trim();
      if (!trimmed) continue;
      const isHttpOnly = trimmed.startsWith('#HttpOnly_');
      if (trimmed.startsWith('#') && !isHttpOnly) continue;
      const cleanLine = isHttpOnly ? trimmed.slice('#HttpOnly_'.length) : trimmed;
      const cols = cleanLine.split('\t');
      if (cols.length >= 7) {
        const dom = cols[0].trim();
        if (dom && !dom.toLowerCase().includes('bilibili') && !dom.toLowerCase().includes('b23.tv')) continue;
        pushPair(cols[5], cols[6], dom || '.bilibili.com', isHttpOnly, Number(cols[4]) || 0);
      }
    }
    if (pairs.length > 0) return pairs;
  }

  // 3. Chuỗi Header hoặc cURL ("Cookie: SESSDATA=...; bili_jct=...")
  let headerBody = raw;
  const curlMatch = raw.match(/(?:-H|--header)\s+['"]cookie\s*:\s*([^'"]+)['"]/i) || raw.match(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/i);
  if (curlMatch && curlMatch[1]) {
    headerBody = curlMatch[1];
  } else {
    headerBody = raw.replace(/^Cookie\s*:\s*/i, '');
  }

  for (const part of headerBody.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) pushPair(k, v);
  }
  return pairs;
}

function validateAndNormalizeCookie(rawCookie) {
  const pairs = parseCookiePairs(rawCookie);
  if (pairs.length === 0) {
    return {
      provided: Boolean(String(rawCookie || '').trim()),
      valid: false,
      headerString: '',
      cookieCount: 0,
      hasSessData: false,
      dedeUserId: '',
      keys: [],
      message: String(rawCookie || '').trim()
        ? 'Không nhận diện được trường Cookie hợp lệ (hỗ trợ Header, Netscape cookies.txt, JSON).'
        : 'Chưa cấu hình Cookie (chỉ truy cập được chất lượng công khai).'
    };
  }

  const keyNames = pairs.map((p) => p.name);
  const sessPair = pairs.find((p) => p.name === 'SESSDATA');
  const uidPair = pairs.find((p) => p.name === 'DedeUserID');
  const hasAuth = pairs.some((p) => BILIBILI_AUTH_COOKIE_KEYS.includes(p.name));

  return {
    provided: true,
    valid: true,
    headerString: pairs.map((p) => `${p.name}=${p.value}`).join('; '),
    cookieCount: pairs.length,
    hasSessData: Boolean(sessPair && sessPair.value),
    hasAuthKeys: hasAuth,
    dedeUserId: uidPair ? uidPair.value : '',
    keys: keyNames,
    pairs,
    message: sessPair && sessPair.value
      ? `Đã nạp ${pairs.length} trường Cookie (có SESSDATA${uidPair ? ` • UID ${uidPair.value}` : ''}).`
      : `Đã nạp ${pairs.length} trường Cookie (thiếu SESSDATA — chất lượng VIP/1080P+ có thể bị giới hạn).`
  };
}

function buildCookieHeaderForUrl(targetUrl, rawCookie) {
  if (!rawCookie || !isBilibiliCookieAllowedUrl(targetUrl)) return '';
  const norm = validateAndNormalizeCookie(rawCookie);
  return norm.valid ? norm.headerString : '';
}

function createTempNetscapeCookieFile(rawCookie) {
  const norm = validateAndNormalizeCookie(rawCookie);
  if (!norm.valid || !norm.pairs.length) return null;

  const tmpFile = path.join(
    os.tmpdir(),
    `bilidl_ck_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.txt`
  );
  const expDefault = Math.floor(Date.now() / 1000) + 86400 * 30;
  const lines = ['# Netscape HTTP Cookie File', ''];

  for (const p of norm.pairs) {
    const dom = p.domain && p.domain.startsWith('.') ? p.domain : `.${p.domain || 'bilibili.com'}`;
    const prefix = p.httpOnly ? `#HttpOnly_${dom}` : dom;
    const exp = p.expires && p.expires > 0 ? Math.floor(p.expires) : expDefault;
    lines.push(`${prefix}\tTRUE\t/\tFALSE\t${exp}\t${p.name}\t${p.value}`);
  }

  fs.writeFileSync(tmpFile, lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  return tmpFile;
}

let cachedGuestBuvid = null;
let cachedGuestAt = 0;

/**
 * Lấy cặp buvid3/buvid4 công khai từ endpoint khởi tạo phiên web của Bilibili (/x/frontend/finger/spi).
 * Giúp API view/playurl nhận diện phiên khách hợp lệ, tránh lỗi HTTP 412 khi chưa đăng nhập.
 */
async function getGuestBuvidHeader() {
  if (cachedGuestBuvid && Date.now() - cachedGuestAt < 30 * 60 * 1000) {
    return cachedGuestBuvid;
  }
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://www.bilibili.com/'
      },
      signal: AbortSignal.timeout(6000)
    });
    const j = await res.json();
    if (j?.code === 0 && j?.data?.b_3) {
      cachedGuestBuvid = `buvid3=${j.data.b_3}${j.data.b_4 ? `; buvid4=${j.data.b_4}` : ''}`;
      cachedGuestAt = Date.now();
      return cachedGuestBuvid;
    }
  } catch {}
  return '';
}

module.exports = {
  isBilibiliCookieAllowedUrl,
  parseCookiePairs,
  validateAndNormalizeCookie,
  buildCookieHeaderForUrl,
  createTempNetscapeCookieFile,
  getGuestBuvidHeader
};
