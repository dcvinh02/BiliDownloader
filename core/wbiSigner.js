/**
 * Bộ ký WBI cho API Bilibili (/x/player/wbi/playurl, /x/space/wbi/arc/search...).
 * Lấy img_key & sub_key từ https://api.bilibili.com/x/web-interface/nav và tạo w_rid + wts theo chuẩn Bilibili.
 */

const crypto = require('crypto');
const { DESKTOP_UA, BILIBILI_REFERER } = require('./constants');
const { buildCookieHeaderForUrl, getGuestBuvidHeader } = require('./cookieStore');
const logger = require('./logger');

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

let cachedKeys = null;
let cachedAt = 0;
let cachedCookieHash = '';
const CACHE_TTL_MS = 25 * 60 * 1000;

function extractKeyFromUrl(urlStr) {
  if (!urlStr) return '';
  const base = urlStr.slice(urlStr.lastIndexOf('/') + 1);
  const dotIdx = base.indexOf('.');
  return dotIdx > 0 ? base.slice(0, dotIdx) : base;
}

function getMixinKey(orig) {
  let out = '';
  for (let i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) {
    const idx = MIXIN_KEY_ENC_TAB[i];
    if (idx < orig.length) out += orig[idx];
  }
  return out.slice(0, 32);
}

function signWbiParams(params, imgKey, subKey, wtsOverride = null) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = wtsOverride || Math.floor(Date.now() / 1000);
  const fullParams = { ...params, wts };
  const chrFilter = /[!'()*]/g;

  const query = Object.keys(fullParams)
    .sort()
    .map((k) => {
      const val = String(fullParams[k]).replace(chrFilter, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(val)}`;
    })
    .join('&');

  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${wRid}`;
}

async function getWbiKeys(cookie = '') {
  const cookieHash = cookie ? crypto.createHash('sha1').update(cookie).digest('hex').slice(0, 10) : '';
  if (cachedKeys && cachedCookieHash === cookieHash && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedKeys;
  }

  const navUrl = 'https://api.bilibili.com/x/web-interface/nav';
  const headers = {
    'User-Agent': DESKTOP_UA,
    Referer: BILIBILI_REFERER
  };
  let ck = buildCookieHeaderForUrl(navUrl, cookie);
  if (!ck) ck = await getGuestBuvidHeader();
  if (ck) headers.Cookie = ck;

  try {
    const res = await fetch(navUrl, { headers, signal: AbortSignal.timeout(8000) });
    const text = await res.text();
    if (/^\s*</.test(text)) {
      throw new Error(`HTTP ${res.status} (HTML block)`);
    }
    const json = JSON.parse(text);
    const wbiImg = json?.data?.wbi_img;
    if (!wbiImg?.img_url || !wbiImg?.sub_url) {
      throw new Error('Phản hồi /nav không có wbi_img');
    }
    const keys = {
      imgKey: extractKeyFromUrl(wbiImg.img_url),
      subKey: extractKeyFromUrl(wbiImg.sub_url),
      isLogin: Boolean(json?.data?.isLogin),
      uname: json?.data?.uname || '',
      mid: json?.data?.mid || null,
      vipStatus: json?.data?.vipStatus || 0
    };
    cachedKeys = keys;
    cachedAt = Date.now();
    cachedCookieHash = cookieHash;
    return keys;
  } catch (err) {
    logger.warn('wbiSigner', `Không lấy được WBI keys: ${err.message}`);
    return null;
  }
}

function clearWbiCache() {
  cachedKeys = null;
  cachedAt = 0;
  cachedCookieHash = '';
}

module.exports = {
  getMixinKey,
  signWbiParams,
  getWbiKeys,
  clearWbiCache
};
