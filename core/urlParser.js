/**
 * Bộ nhận diện & phân tích URL chuyên biệt cho Bilibili (Stage 5).
 * Kế thừa cơ chế tách URL & giải mã b23.tv của CNDownload, nâng cấp bảo toàn ?p= (multi-part),
 * hỗ trợ BV/AV, PGC (ep/ss/md), Collection/Series/List, Space UP chủ và bilibili.tv.
 * Từ chối rõ ràng mọi URL không thuộc Bilibili.
 */

const { DESKTOP_UA, BILIBILI_REFERER } = require('./constants');
const { buildCookieHeaderForUrl } = require('./cookieStore');
const logger = require('./logger');

const BILIBILI_HOSTS = [
  'bilibili.com',
  'b23.tv',
  'bilibili.tv',
  'bili2233.cn'
];

function isBilibiliHost(hostname = '') {
  const h = String(hostname || '').toLowerCase();
  return BILIBILI_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

function extractUrlOrIdFromInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  const trimmed = rawInput.trim();
  if (!trimmed) return '';

  // Trích từ <iframe src="..."> nếu có
  const iframeMatch = trimmed.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch && iframeMatch[1]) {
    let src = iframeMatch[1].trim();
    if (src.startsWith('//')) src = `https:${src}`;
    return src;
  }

  // Trích URL http/https từ văn bản chia sẻ hỗn hợp của app Bilibili
  const urlMatch = trimmed.match(/https?:\/\/[^\s"'<>\\，。！？；：）】》]+/i);
  if (urlMatch) {
    return urlMatch[0].replace(/[.,;!?)\]}'"`]+$/, '');
  }

  // Cho phép người dùng nhập thẳng mã BV1... hoặc av123...
  const directBv = trimmed.match(/^(BV[0-9A-Za-z]{10})$/i);
  if (directBv) {
    return `https://www.bilibili.com/video/${directBv[1]}`;
  }
  const directAv = trimmed.match(/^(av\d+)$/i);
  if (directAv) {
    return `https://www.bilibili.com/video/${directAv[1].toLowerCase()}`;
  }

  return trimmed;
}

/**
 * Theo dõi chuỗi redirect 301/302 (đặc biệt cho b23.tv) với giới hạn hop và timeout.
 */
async function resolveBilibiliRedirect(initialUrl, options = {}) {
  const maxHops = options.maxHops || 6;
  const timeoutMs = options.timeoutMs || 6000;
  let currentUrl = initialUrl;
  const redirectChain = [currentUrl];
  const collectedCookies = [];

  for (let i = 0; i < maxHops; i++) {
    const cookieHeader = options.cookie ? buildCookieHeaderForUrl(currentUrl, options.cookie) : '';
    const headers = {
      'User-Agent': DESKTOP_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,vi;q=0.7',
      Referer: BILIBILI_REFERER
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    } else if (collectedCookies.length > 0 && isBilibiliHost(new URL(currentUrl).hostname)) {
      headers.Cookie = collectedCookies.join('; ');
    }

    try {
      const res = await fetch(currentUrl, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });

      const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of setCookie) {
        const pair = c.split(';')[0];
        if (pair && !collectedCookies.includes(pair)) collectedCookies.push(pair);
      }

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        const nextUrl = new URL(loc, currentUrl).toString();
        currentUrl = nextUrl;
        redirectChain.push(currentUrl);
        continue;
      }

      return {
        finalUrl: currentUrl,
        redirectChain,
        status: res.status
      };
    } catch (err) {
      logger.warn('urlParser', `Resolve redirect thất bại tại ${currentUrl}: ${err.message}`);
      return {
        finalUrl: currentUrl,
        redirectChain,
        status: 0,
        error: err.message
      };
    }
  }

  return {
    finalUrl: currentUrl,
    redirectChain,
    status: 200
  };
}

/**
 * Phân tích cấu trúc URL Bilibili sau khi đã bỏ ký tự thừa và resolve shortlink (nếu cần).
 */
function classifyBilibiliUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Đường dẫn URL không hợp lệ. Vui lòng dán link Bilibili (bilibili.com, b23.tv) hoặc mã BV/AV.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Chỉ hỗ trợ giao thức HTTP/HTTPS.');
  }

  const host = parsed.hostname.toLowerCase();
  if (!isBilibiliHost(host)) {
    throw new Error(
      `Không hỗ trợ miền "${host}". BiliDownloader chỉ hỗ trợ duy nhất nền tảng Bilibili (bilibili.com, b23.tv, space.bilibili.com, bilibili.tv).`
    );
  }

  const pathname = parsed.pathname;
  const params = parsed.searchParams;

  // 1. bilibili.tv quốc tế
  if (host === 'bilibili.tv' || host.endsWith('.bilibili.tv')) {
    const mTv = pathname.match(/\/(?:video|play\/[^/]+)\/(\d{5,22})/i) || pathname.match(/\/play\/(\d{5,22})/i);
    return {
      contentType: 'bilibili_tv',
      host,
      videoId: mTv ? mTv[1] : null,
      cleanUrl: `${parsed.origin}${pathname}`,
      rawUrl: urlStr
    };
  }

  // 2. Link rút gọn b23.tv (nếu chưa resolve được)
  if (host === 'b23.tv' || host === 'bili2233.cn') {
    return {
      contentType: 'shortlink',
      host,
      cleanUrl: urlStr,
      rawUrl: urlStr
    };
  }

  // 3. Kênh / Trang cá nhân UP chủ (space.bilibili.com)
  if (host === 'space.bilibili.com') {
    const midMatch = pathname.match(/^\/(\d+)/);
    const mid = midMatch ? midMatch[1] : null;
    if (!mid) {
      throw new Error('Không tìm thấy UID (mid) hợp lệ trong link Space Bilibili.');
    }

    // Collection / Season hoặc Series trên Space
    const sid = params.get('sid');
    const listMatch = pathname.match(/\/lists\/(\d+)/);
    const listType = params.get('type');
    if (pathname.includes('/channel/collectiondetail') || (listMatch && listType === 'season')) {
      const seasonId = sid || (listMatch ? listMatch[1] : null);
      return {
        contentType: 'collection',
        collectionKind: 'season',
        mid,
        seasonId,
        cleanUrl: `https://space.bilibili.com/${mid}/lists/${seasonId}?type=season`,
        rawUrl: urlStr
      };
    }
    if (pathname.includes('/channel/seriesdetail') || (listMatch && listType === 'series')) {
      const seriesId = sid || (listMatch ? listMatch[1] : null);
      return {
        contentType: 'collection',
        collectionKind: 'series',
        mid,
        seriesId,
        cleanUrl: `https://space.bilibili.com/${mid}/lists/${seriesId}?type=series`,
        rawUrl: urlStr
      };
    }

    return {
      contentType: 'space',
      mid,
      cleanUrl: `https://space.bilibili.com/${mid}/video`,
      rawUrl: urlStr
    };
  }

  // 4. Bangumi / PGC (ep, ss, md)
  const epMatch = pathname.match(/\/bangumi\/play\/ep(\d+)/i);
  if (epMatch) {
    return {
      contentType: 'pgc',
      epId: epMatch[1],
      seasonId: null,
      mediaId: null,
      cleanUrl: `https://www.bilibili.com/bangumi/play/ep${epMatch[1]}`,
      rawUrl: urlStr
    };
  }
  const ssMatch = pathname.match(/\/bangumi\/play\/ss(\d+)/i);
  if (ssMatch) {
    return {
      contentType: 'pgc',
      epId: null,
      seasonId: ssMatch[1],
      mediaId: null,
      cleanUrl: `https://www.bilibili.com/bangumi/play/ss${ssMatch[1]}`,
      rawUrl: urlStr
    };
  }
  const mdMatch = pathname.match(/\/bangumi\/media\/md(\d+)/i);
  if (mdMatch) {
    return {
      contentType: 'pgc',
      epId: null,
      seasonId: null,
      mediaId: mdMatch[1],
      cleanUrl: `https://www.bilibili.com/bangumi/media/md${mdMatch[1]}`,
      rawUrl: urlStr
    };
  }

  // 5. Video BV hoặc AV (bao gồm player.bilibili.com, m.bilibili.com, /list/watchlater?bvid=...)
  let bvid = params.get('bvid') || null;
  let aid = params.get('aid') || null;
  let pageNum = parseInt(params.get('p') || params.get('page') || '1', 10);
  if (!Number.isFinite(pageNum) || pageNum < 1) pageNum = 1;

  if (!bvid && !aid) {
    const mBv = pathname.match(/\/(BV[0-9A-Za-z]{10})\b/i);
    if (mBv) bvid = mBv[1];
  }
  if (!bvid && !aid) {
    const mAv = pathname.match(/\/av(\d+)\b/i);
    if (mAv) aid = mAv[1];
  }

  if (bvid || aid) {
    const videoId = bvid || `av${aid}`;
    const pSuffix = pageNum > 1 ? `?p=${pageNum}` : '';
    return {
      contentType: 'video',
      host,
      bvid,
      aid,
      videoId,
      pageNum,
      cidParam: params.get('cid') || null,
      cleanUrl: `https://www.bilibili.com/video/${videoId}${pSuffix}`,
      embedUrl: bvid
        ? `https://player.bilibili.com/player.html?bvid=${bvid}&p=${pageNum}&high_quality=1&danmaku=0`
        : `https://player.bilibili.com/player.html?aid=${aid}&p=${pageNum}&high_quality=1&danmaku=0`,
      mobileUrl: `https://m.bilibili.com/video/${videoId}${pSuffix}`,
      rawUrl: urlStr
    };
  }

  // 6. Danh sách medialist / list trên www.bilibili.com
  const listPageMatch = pathname.match(/\/list\/ml(\d+)/i);
  if (listPageMatch) {
    return {
      contentType: 'medialist',
      mediaListId: listPageMatch[1],
      cleanUrl: `https://www.bilibili.com/list/ml${listPageMatch[1]}`,
      rawUrl: urlStr
    };
  }

  throw new Error('Không tìm thấy mã video BV/AV, tập Bangumi (ep/ss), hoặc UID kênh Bilibili hợp lệ trong URL.');
}

async function parseBilibiliInput(rawInput, options = {}) {
  const extracted = extractUrlOrIdFromInput(rawInput);
  if (!extracted) {
    throw new Error('Vui lòng nhập đường dẫn Bilibili hoặc mã BV/AV.');
  }

  if (!/^https?:\/\//i.test(extracted)) {
    throw new Error('Đầu vào không chứa URL Bilibili hợp lệ hoặc mã BV/AV.');
  }

  const initialClass = classifyBilibiliUrl(extracted);
  let resolvedUrl = extracted;
  let redirectChain = [extracted];

  if (initialClass.contentType === 'shortlink') {
    const redir = await resolveBilibiliRedirect(extracted, options);
    resolvedUrl = redir.finalUrl || extracted;
    redirectChain = redir.redirectChain || [extracted];
  }

  const finalClass = classifyBilibiliUrl(resolvedUrl);
  if (finalClass.contentType === 'shortlink') {
    throw new Error('Không thể giải mã link rút gọn b23.tv (có thể link hỏng hoặc mạng bị chặn).');
  }

  return {
    inputRaw: rawInput,
    extractedUrl: extracted,
    resolvedUrl,
    redirectChain,
    ...finalClass
  };
}

module.exports = {
  isBilibiliHost,
  extractUrlOrIdFromInput,
  resolveBilibiliRedirect,
  classifyBilibiliUrl,
  parseBilibiliInput
};
