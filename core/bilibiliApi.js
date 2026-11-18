/**
 * Bilibili WebAPI & Stream Extractor (Stage 6 & Stage 7).
 * - Kế thừa cơ chế view + playurl của CNDownload, nâng cấp lên:
 *   + WBI Signing + DASH fnval=4048&fourk=1 để lấy danh sách chất lượng thực tế (360P -> 8K, AVC/HEVC/AV1, Audio tách riêng)
 *   + Vẫn gọi fallback HTML5 progressive MP4 (fnval=1) & yt-dlp khi cần
 *   + Lấy đủ metadata thực tế: title, cover, author, uid (mid), avatar, BV/AV, CID, duration, pubdate, view, like, coin, favorite, share, reply, danmaku, desc, pages[], ugc_season (playlist)
 *   + Hỗ trợ Bangumi/PGC (ep/ss/md), Collection/Series và quét kênh UP chủ (Space)
 */

const {
  DESKTOP_UA,
  BILIBILI_REFERER,
  QUALITY_MAP,
  VIDEO_CODEC_MAP,
  AUDIO_QUALITY_MAP,
  DASH_FULL_FNVAL
} = require('./constants');
const { buildCookieHeaderForUrl, getGuestBuvidHeader } = require('./cookieStore');
const { parseBilibiliInput } = require('./urlParser');
const { getWbiKeys, signWbiParams } = require('./wbiSigner');
const { extractViaYtDlp, fetchSpaceUploadsViaYtDlp } = require('./ytdlpFallback');
const logger = require('./logger');

function normalizeHttps(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url.replace(/^http:\/\//i, 'https://');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch JSON an toàn có retry giới hạn (cho lỗi mạng/5xx) và phát hiện chặn 412 / HTML block.
 */
async function fetchBilibiliJson(url, cookie = '', options = {}) {
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 12000;
  const referer = options.referer || BILIBILI_REFERER;

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const headers = {
      'User-Agent': DESKTOP_UA,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    };
    let ck = buildCookieHeaderForUrl(url, cookie);
    if (!ck && url.includes('bilibili.com')) {
      ck = await getGuestBuvidHeader();
    } else if (ck && url.includes('bilibili.com') && !/buvid3=/i.test(ck)) {
      const guest = await getGuestBuvidHeader();
      if (guest) ck = `${ck}; ${guest}`;
    }
    if (ck) headers.Cookie = ck;

    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await res.text();

      if (res.status === 412 || /^\s*</.test(text)) {
        throw Object.assign(
          new Error(
            `Bilibili tạm giới hạn truy cập từ IP này (HTTP ${res.status}). Hãy chờ vài phút rồi thử lại hoặc nhập Cookie tài khoản Bilibili.`
          ),
          { fatal: true, status: res.status }
        );
      }

      if (res.status >= 500 && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw Object.assign(new Error(`Bilibili trả dữ liệu không phải JSON hợp lệ (HTTP ${res.status}).`), {
          fatal: res.status < 500
        });
      }
      return json;
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt >= retries) break;
      await sleep(450 * (attempt + 1));
    }
  }
  throw lastErr || new Error('Không thể kết nối tới API Bilibili.');
}

/**
 * Chuyển chuỗi frameRate ("60.000", "29.97", "30000/1001") sang số FPS thực tế nếu hợp lệ.
 */
function parseFrameRate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.includes('/')) {
    const [num, den] = s.split('/').map(Number);
    if (num > 0 && den > 0) return Math.round((num / den) * 100) / 100;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/**
 * Chuẩn hóa luồng từ phản hồi PlayURL (cả DASH lẫn Progressive MP4 durl).
 * Chỉ trả về luồng THỰC SỰ tồn tại trong API response, tuyệt đối không tạo chất lượng giả.
 */
function normalizePlayUrlStreams(playData, durationSec = 0) {
  const videoStreams = [];
  const audioStreams = [];
  const progressiveStreams = [];
  const supportFormats = Array.isArray(playData?.support_formats) ? playData.support_formats : [];

  const formatMetaMap = new Map();
  for (const sf of supportFormats) {
    if (sf && typeof sf.quality === 'number') {
      formatMetaMap.set(sf.quality, sf);
    }
  }

  // 1. Luồng DASH tách riêng (video[] + audio[])
  const dash = playData?.dash;
  if (dash && Array.isArray(dash.video)) {
    for (const v of dash.video) {
      const url = v.baseUrl || v.base_url;
      if (!url) continue;

      const qn = Number(v.id);
      const qMeta = QUALITY_MAP[qn];
      const sfMeta = formatMetaMap.get(qn);
      const codecMeta = VIDEO_CODEC_MAP[v.codecid] || {
        key: String(v.codecs || 'video').split('.')[0].toLowerCase(),
        name: v.codecs || `Codec ${v.codecid || ''}`.trim()
      };
      const fps = parseFrameRate(v.frameRate || v.frame_rate);
      const bandwidth = Number(v.bandwidth) || 0;
      const estimatedBytes =
        bandwidth > 0 && durationSec > 0 ? Math.round((bandwidth * durationSec) / 8) : null;

      videoStreams.push({
        streamKey: `dash-v-${qn}-${v.codecid || 0}`,
        streamKind: 'dash_video',
        qn,
        qualityLabel: qMeta?.shortLabel || sfMeta?.new_description || sfMeta?.display_desc || `${v.height || qn}P`,
        qualityDetail: qMeta?.label || sfMeta?.new_description || '',
        width: Number(v.width) || null,
        height: Number(v.height) || null,
        fps,
        bandwidth,
        bitrateKbps: bandwidth > 0 ? Math.round(bandwidth / 1000) : null,
        codecid: Number(v.codecid) || null,
        codecKey: codecMeta.key,
        codecName: codecMeta.name,
        codecsRaw: v.codecs || '',
        mimeType: v.mimeType || v.mime_type || 'video/mp4',
        estimatedBytes,
        hasAudio: false,
        requiresMerge: true,
        url,
        backupUrls: (v.backupUrl || v.backup_url || []).filter(Boolean)
      });
    }

    // Sắp xếp videoStreams: độ phân giải / qn giảm dần -> H.264/HEVC/AV1
    videoStreams.sort((a, b) => {
      if (b.qn !== a.qn) return b.qn - a.qn;
      const codecOrder = { avc: 3, hevc: 2, av1: 1 };
      return (codecOrder[b.codecKey] || 0) - (codecOrder[a.codecKey] || 0);
    });
  }

  // Audio DASH thường + Dolby + Hi-Res FLAC
  const rawAudioCandidates = [];
  if (dash && Array.isArray(dash.audio)) {
    rawAudioCandidates.push(...dash.audio);
  }
  if (dash?.dolby && Array.isArray(dash.dolby.audio)) {
    rawAudioCandidates.push(...dash.dolby.audio);
  }
  if (dash?.flac && dash.flac.audio && (dash.flac.audio.baseUrl || dash.flac.audio.base_url)) {
    rawAudioCandidates.push(dash.flac.audio);
  }

  const seenAudio = new Set();
  for (const a of rawAudioCandidates) {
    const url = a.baseUrl || a.base_url;
    if (!url) continue;
    const aid = Number(a.id);
    if (seenAudio.has(aid)) continue;
    seenAudio.add(aid);

    const aMeta = AUDIO_QUALITY_MAP[aid];
    const bandwidth = Number(a.bandwidth) || 0;
    const bitrateKbps = bandwidth > 0 ? Math.round(bandwidth / 1000) : aMeta?.kbps || null;
    const estimatedBytes =
      bandwidth > 0 && durationSec > 0 ? Math.round((bandwidth * durationSec) / 8) : null;

    audioStreams.push({
      streamKey: `dash-a-${aid}`,
      streamKind: 'dash_audio',
      audioId: aid,
      label: aMeta?.label || `${bitrateKbps || '?'} Kbps`,
      bandwidth,
      bitrateKbps,
      codecsRaw: a.codecs || 'mp4a.40.2',
      mimeType: a.mimeType || a.mime_type || 'audio/mp4',
      ext: aMeta?.ext || 'm4a',
      estimatedBytes,
      url,
      backupUrls: (a.backupUrl || a.backup_url || []).filter(Boolean)
    });
  }
  audioStreams.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));

  // 2. Luồng Progressive MP4 gộp sẵn (durl) — giống cơ chế HTML5 fnval=1 của CNDownload
  if (Array.isArray(playData?.durl) && playData.durl.length > 0) {
    const item = playData.durl[0];
    if (item && item.url) {
      const qn = Number(playData.quality) || 64;
      const qMeta = QUALITY_MAP[qn];
      progressiveStreams.push({
        streamKey: `mp4-durl-${qn}`,
        streamKind: 'progressive_mp4',
        qn,
        qualityLabel: qMeta?.shortLabel || `${qn}`,
        qualityDetail: `${qMeta?.label || 'MP4'} (Ghép sẵn Hình + Tiếng)`,
        width: null,
        height: null,
        fps: null,
        bandwidth: null,
        bitrateKbps: null,
        codecid: 7,
        codecKey: 'avc',
        codecName: 'H.264 (AVC)',
        codecsRaw: 'avc1',
        mimeType: 'video/mp4',
        estimatedBytes: Number(item.size) || null,
        exactBytes: Number(item.size) || null,
        hasAudio: true,
        requiresMerge: false,
        url: item.url,
        backupUrls: (item.backup_url || []).filter(Boolean)
      });
    }
  }

  // 3. Các mức chất lượng được liệt kê trong support_formats nhưng bị khóa quyền truy cập hiện tại (thiếu Cookie/VIP)
  const unlockedQns = new Set([
    ...videoStreams.map((v) => v.qn),
    ...progressiveStreams.map((p) => p.qn)
  ]);
  const lockedQualities = supportFormats
    .filter((sf) => sf && !unlockedQns.has(Number(sf.quality)))
    .map((sf) => ({
      qn: Number(sf.quality),
      qualityLabel: QUALITY_MAP[sf.quality]?.shortLabel || sf.new_description || `${sf.quality}`,
      reason: QUALITY_MAP[sf.quality]?.requiresVip
        ? 'Cần Cookie tài khoản VIP Bilibili'
        : 'Cần Cookie đăng nhập Bilibili'
    }));

  return {
    videoStreams,
    audioStreams,
    progressiveStreams,
    lockedQualities,
    acceptQuality: Array.isArray(playData?.accept_quality) ? playData.accept_quality : [],
    acceptDescription: Array.isArray(playData?.accept_description) ? playData.accept_description : []
  };
}

/**
 * Lấy danh sách chất lượng thực tế cho 1 cặp (bvid/aid, cid) hoặc PGC (epId, cid).
 */
async function fetchPlayUrlQualities({ bvid = null, aid = null, cid, epId = null, durationSec = 0, cookie = '' }) {
  if (!cid) throw new Error('Thiếu CID để truy vấn chất lượng luồng phát.');

  let dashData = null;
  let html5Data = null;

  if (epId) {
    // PGC Bangumi endpoint
    const pgcUrl = `https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=${encodeURIComponent(
      epId
    )}&cid=${encodeURIComponent(cid)}&qn=127&fnval=${DASH_FULL_FNVAL}&fnver=0&fourk=1`;
    const pgcJson = await fetchBilibiliJson(pgcUrl, cookie).catch(() => null);
    if (pgcJson && pgcJson.code === 0) {
      dashData = pgcJson.result?.video_info || pgcJson.result || pgcJson.data || null;
    }
  } else {
    // UGC PlayURL: Ưu tiên WBI PlayURL DASH (fnval=4048) để lấy đủ 360P..8K + codec + audio tách riêng
    const baseParams = {
      ...(bvid ? { bvid } : { aid }),
      cid,
      qn: 127,
      fnval: DASH_FULL_FNVAL,
      fnver: 0,
      fourk: 1,
      otype: 'json'
    };
    if (!cookie) baseParams.try_look = 1;

    const wbiKeys = await getWbiKeys(cookie);
    if (wbiKeys) {
      const signedQuery = signWbiParams(baseParams, wbiKeys.imgKey, wbiKeys.subKey);
      const wbiUrl = `https://api.bilibili.com/x/player/wbi/playurl?${signedQuery}`;
      const wbiJson = await fetchBilibiliJson(wbiUrl, cookie).catch(() => null);
      if (wbiJson && wbiJson.code === 0 && wbiJson.data) {
        dashData = wbiJson.data;
      }
    }

    // Fallback non-WBI DASH nếu WBI bị lỗi
    if (!dashData) {
      const qs = new URLSearchParams(baseParams).toString();
      const dashUrl = `https://api.bilibili.com/x/player/playurl?${qs}`;
      const dashJson = await fetchBilibiliJson(dashUrl, cookie).catch(() => null);
      if (dashJson && dashJson.code === 0 && dashJson.data) {
        dashData = dashJson.data;
      }
    }

    // Luồng HTML5 MP4 progressive (đúng cơ chế gốc của CNDownload: fnval=1&platform=html5 cho cả HD và Fast 360P)
    const idParam = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
    const html5UrlHd = `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${encodeURIComponent(
      cid
    )}&qn=80&fnval=1&platform=html5&high_quality=1`;
    const html5UrlFast = `https://api.bilibili.com/x/player/playurl?${idParam}&cid=${encodeURIComponent(
      cid
    )}&qn=16&fnval=1&platform=html5&high_quality=0`;

    const [html5JsonHd, html5JsonFast] = await Promise.all([
      fetchBilibiliJson(html5UrlHd, cookie).catch(() => null),
      fetchBilibiliJson(html5UrlFast, cookie).catch(() => null)
    ]);
    const listHtml5 = [];
    if (html5JsonHd && html5JsonHd.code === 0 && html5JsonHd.data) listHtml5.push(html5JsonHd.data);
    if (html5JsonFast && html5JsonFast.code === 0 && html5JsonFast.data) listHtml5.push(html5JsonFast.data);
    html5Data = listHtml5;
  }

  const primaryNorm = dashData ? normalizePlayUrlStreams(dashData, durationSec) : null;
  const html5Norms = Array.isArray(html5Data)
    ? html5Data.map((hd) => normalizePlayUrlStreams(hd, durationSec))
    : [];

  const videoStreams = primaryNorm?.videoStreams || [];
  const audioStreams = primaryNorm?.audioStreams || [];
  const progressiveStreams = [
    ...(primaryNorm?.progressiveStreams || []),
    ...html5Norms.flatMap((n) => n.progressiveStreams || [])
  ].filter((item, idx, arr) => arr.findIndex((x) => x.qn === item.qn || x.url === item.url) === idx);
  progressiveStreams.sort((a, b) => (b.qn || 0) - (a.qn || 0));

  const availableQns = new Set([
    ...videoStreams.map((v) => v.qn),
    ...progressiveStreams.map((p) => p.qn)
  ]);
  const lockedQualities = (primaryNorm?.lockedQualities || []).filter((lq) => !availableQns.has(lq.qn));

  return {
    videoStreams,
    audioStreams,
    progressiveStreams,
    lockedQualities,
    hasDash: videoStreams.length > 0,
    hasProgressive: progressiveStreams.length > 0,
    engine: videoStreams.length > 0 ? 'Bilibili WBI DASH (fnval=4048) + HTML5 MP4' : 'Bilibili HTML5 Progressive'
  };
}

/**
 * Phân tích Video BV / AV (kèm multi-part pages[] và ugc_season playlist nếu có).
 */
async function fetchStandardVideoInfo(parsedUrl, cookie = '') {
  const queryParam = parsedUrl.bvid
    ? `bvid=${encodeURIComponent(parsedUrl.bvid)}`
    : `aid=${encodeURIComponent(parsedUrl.aid)}`;

  const viewUrl = `https://api.bilibili.com/x/web-interface/view?${queryParam}`;
  const viewJson = await fetchBilibiliJson(viewUrl, cookie, {
    referer: parsedUrl.cleanUrl || BILIBILI_REFERER
  });

  if (viewJson.code !== 0 || !viewJson.data) {
    if (viewJson.code === -404 || viewJson.code === 62002) {
      throw new Error('Video không tồn tại, đã bị xóa hoặc bị ẩn bởi tác giả.');
    }
    if (viewJson.code === -403) {
      throw new Error('Video bị giới hạn quyền truy cập (cần đăng nhập/Cookie hoặc quyền thành viên).');
    }
    throw new Error(`Bilibili API trả lỗi (${viewJson.code}): ${viewJson.message || 'Không xác định'}`);
  }

  const d = viewJson.data;
  const pages = Array.isArray(d.pages)
    ? d.pages.map((p) => ({
        page: Number(p.page),
        cid: Number(p.cid),
        title: p.part || `Phần ${p.page}`,
        duration: Number(p.duration) || 0,
        dimension: p.dimension || null,
        url: `https://www.bilibili.com/video/${d.bvid}${p.page > 1 ? `?p=${p.page}` : ''}`
      }))
    : [];

  const targetPageNum = parsedUrl.pageNum || 1;
  const selectedPage = pages.find((p) => p.page === targetPageNum) || pages[0] || {
    page: 1,
    cid: Number(d.cid),
    title: d.title,
    duration: Number(d.duration) || 0
  };

  const cid = selectedPage.cid || Number(d.cid);
  const partDuration = selectedPage.duration || Number(d.duration) || 0;

  const streams = await fetchPlayUrlQualities({
    bvid: d.bvid,
    aid: d.aid,
    cid,
    durationSec: partDuration,
    cookie
  });

  // Trích thông tin Collection/Playlist (ugc_season) nếu video thuộc một bộ sưu tập
  let playlist = null;
  if (d.ugc_season && Array.isArray(d.ugc_season.sections)) {
    const episodes = [];
    for (const sec of d.ugc_season.sections) {
      for (const ep of sec.episodes || []) {
        episodes.push({
          bvid: ep.bvid,
          aid: ep.aid,
          cid: ep.cid,
          title: ep.title || ep.arc?.title || ep.bvid,
          duration: Number(ep.arc?.duration || ep.page?.duration) || 0,
          cover: normalizeHttps(ep.arc?.pic || ''),
          url: `https://www.bilibili.com/video/${ep.bvid}`
        });
      }
    }
    if (episodes.length > 0) {
      playlist = {
        type: 'ugc_season',
        seasonId: d.ugc_season.id,
        title: d.ugc_season.title || 'Bộ sưu tập',
        cover: normalizeHttps(d.ugc_season.cover || ''),
        totalEpisodes: episodes.length,
        episodes
      };
    }
  }

  return {
    contentType: 'video',
    bvid: d.bvid,
    aid: d.aid ? String(d.aid) : null,
    videoId: d.bvid,
    cid: String(cid),
    title: d.title,
    description: d.desc || '',
    tname: d.tname || '',
    pubdate: Number(d.pubdate) || null,
    pubdateText: d.pubdate ? new Date(d.pubdate * 1000).toLocaleString('vi-VN') : null,
    author: d.owner?.name || null,
    authorMid: d.owner?.mid ? String(d.owner.mid) : null,
    authorAvatar: normalizeHttps(d.owner?.face || ''),
    cover: normalizeHttps(d.pic || ''),
    duration: partDuration,
    totalDuration: Number(d.duration) || partDuration,
    stats: {
      views: d.stat?.view ?? null,
      likes: d.stat?.like ?? null,
      coins: d.stat?.coin ?? null,
      favorites: d.stat?.favorite ?? null,
      shares: d.stat?.share ?? null,
      comments: d.stat?.reply ?? null,
      danmaku: d.stat?.danmaku ?? null
    },
    pages,
    selectedPageNum: selectedPage.page,
    playlist,
    cleanUrl: `https://www.bilibili.com/video/${d.bvid}${selectedPage.page > 1 ? `?p=${selectedPage.page}` : ''}`,
    embedUrl: `https://player.bilibili.com/player.html?bvid=${d.bvid}&cid=${cid}&p=${selectedPage.page}&high_quality=1&danmaku=0`,
    streams
  };
}

/**
 * Phân tích Bangumi / PGC (ep, ss, md) công khai.
 */
async function fetchPgcInfo(parsedUrl, cookie = '') {
  let seasonId = parsedUrl.seasonId;
  let epId = parsedUrl.epId;

  if (!seasonId && !epId && parsedUrl.mediaId) {
    const mJson = await fetchBilibiliJson(
      `https://api.bilibili.com/pgc/review/user?media_id=${encodeURIComponent(parsedUrl.mediaId)}`,
      cookie
    );
    seasonId = mJson?.result?.media?.season_id ? String(mJson.result.media.season_id) : null;
  }

  const query = epId ? `ep_id=${encodeURIComponent(epId)}` : `season_id=${encodeURIComponent(seasonId)}`;
  const pgcJson = await fetchBilibiliJson(`https://api.bilibili.com/pgc/view/web/season?${query}`, cookie);

  if (pgcJson.code !== 0 || !pgcJson.result) {
    throw new Error(`Không lấy được thông tin Bangumi/PGC (${pgcJson.code}): ${pgcJson.message || 'Không tồn tại hoặc bị giới hạn khu vực.'}`);
  }

  const r = pgcJson.result;
  const rawEps = Array.isArray(r.episodes) ? r.episodes : [];
  const episodes = rawEps.map((ep, idx) => ({
    index: idx + 1,
    epId: String(ep.id || ep.ep_id),
    bvid: ep.bvid || '',
    aid: ep.aid ? String(ep.aid) : null,
    cid: ep.cid ? String(ep.cid) : null,
    title: ep.show_title || ep.long_title || ep.title || `Tập ${idx + 1}`,
    duration: ep.duration ? Math.round(ep.duration / 1000) : 0,
    cover: normalizeHttps(ep.cover || r.cover || ''),
    badge: ep.badge || '',
    url: `https://www.bilibili.com/bangumi/play/ep${ep.id || ep.ep_id}`
  }));

  const currentEp = (epId && episodes.find((e) => e.epId === String(epId))) || episodes[0];
  if (!currentEp || !currentEp.cid) {
    throw new Error('Không tìm thấy tập phim hợp lệ trong mùa Bangumi này.');
  }

  const streams = await fetchPlayUrlQualities({
    bvid: currentEp.bvid || null,
    aid: currentEp.aid || null,
    cid: currentEp.cid,
    epId: currentEp.epId,
    durationSec: currentEp.duration || 0,
    cookie
  });

  return {
    contentType: 'pgc',
    bvid: currentEp.bvid || null,
    aid: currentEp.aid || null,
    videoId: `ep${currentEp.epId}`,
    epId: currentEp.epId,
    seasonId: String(r.season_id || seasonId || ''),
    cid: currentEp.cid,
    title: `${r.season_title || r.title || 'Bangumi'} - ${currentEp.title}`,
    description: r.evaluate || '',
    pubdate: null,
    pubdateText: r.publish?.pub_time_show || null,
    author: r.up_info?.uname || 'Bilibili PGC',
    authorMid: r.up_info?.mid ? String(r.up_info.mid) : null,
    authorAvatar: normalizeHttps(r.up_info?.avatar || ''),
    cover: normalizeHttps(currentEp.cover || r.cover || ''),
    duration: currentEp.duration,
    stats: {
      views: r.stat?.views ?? null,
      likes: r.stat?.likes ?? null,
      coins: r.stat?.coins ?? null,
      favorites: r.stat?.favorites ?? null,
      shares: r.stat?.share ?? null,
      comments: r.stat?.reply ?? null,
      danmaku: r.stat?.danmakus ?? null
    },
    pages: [],
    playlist: {
      type: 'pgc_season',
      seasonId: String(r.season_id || ''),
      title: r.season_title || r.title || 'Bangumi',
      cover: normalizeHttps(r.cover || ''),
      totalEpisodes: episodes.length,
      episodes
    },
    cleanUrl: currentEp.url,
    embedUrl: null,
    streams
  };
}

/**
 * Lấy danh sách video của Collection / Series / Medialist.
 */
async function fetchCollectionInfo(parsedUrl, cookie = '') {
  let title = 'Danh sách phát Bilibili';
  let episodes = [];

  if (parsedUrl.collectionKind === 'season') {
    const url = `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=${encodeURIComponent(
      parsedUrl.mid
    )}&season_id=${encodeURIComponent(parsedUrl.seasonId)}&sort_reverse=false&page_num=1&page_size=50`;
    const j = await fetchBilibiliJson(url, cookie);
    if (j.code !== 0 || !j.data) throw new Error(`Không đọc được Collection (${j.code}): ${j.message || ''}`);
    title = j.data.meta?.name || title;
    episodes = (j.data.archives || []).map((a) => ({
      bvid: a.bvid,
      aid: String(a.aid),
      title: a.title,
      duration: Number(a.duration) || 0,
      cover: normalizeHttps(a.pic || ''),
      views: a.stat?.view ?? null,
      pubdate: a.pubdate || null,
      url: `https://www.bilibili.com/video/${a.bvid}`
    }));
  } else if (parsedUrl.collectionKind === 'series') {
    const url = `https://api.bilibili.com/x/series/archives?mid=${encodeURIComponent(
      parsedUrl.mid
    )}&series_id=${encodeURIComponent(parsedUrl.seriesId)}&only_normal=true&sort=desc&pn=1&ps=50`;
    const j = await fetchBilibiliJson(url, cookie);
    if (j.code !== 0 || !j.data) throw new Error(`Không đọc được Series (${j.code}): ${j.message || ''}`);
    episodes = (j.data.archives || []).map((a) => ({
      bvid: a.bvid,
      aid: String(a.aid),
      title: a.title,
      duration: Number(a.duration) || 0,
      cover: normalizeHttps(a.pic || ''),
      views: a.stat?.view ?? null,
      pubdate: a.pubdate || null,
      url: `https://www.bilibili.com/video/${a.bvid}`
    }));
  } else if (parsedUrl.mediaListId) {
    const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${encodeURIComponent(
      parsedUrl.mediaListId
    )}&pn=1&ps=40&platform=web`;
    const j = await fetchBilibiliJson(url, cookie);
    if (j.code !== 0 || !j.data) throw new Error(`Không đọc được Medialist (${j.code}): ${j.message || ''}`);
    title = j.data.info?.title || title;
    episodes = (j.data.medias || []).map((m) => ({
      bvid: m.bvid,
      aid: String(m.id),
      title: m.title,
      duration: Number(m.duration) || 0,
      cover: normalizeHttps(m.cover || ''),
      views: m.cnt_info?.play ?? null,
      url: `https://www.bilibili.com/video/${m.bvid}`
    }));
  }

  if (episodes.length === 0) {
    throw new Error('Danh sách phát không có video công khai hoặc yêu cầu Cookie đăng nhập.');
  }

  // Phân tích sẵn video đầu tiên để hiển thị đầy đủ UI
  const firstParsed = await parseBilibiliInput(episodes[0].url, { cookie });
  const firstInfo = await fetchStandardVideoInfo(firstParsed, cookie);
  firstInfo.playlist = {
    type: parsedUrl.collectionKind || 'medialist',
    title,
    totalEpisodes: episodes.length,
    episodes
  };
  return firstInfo;
}

/**
 * Fallback cho bilibili.tv bằng yt-dlp.
 */
async function fetchBilibiliTvInfo(parsedUrl, cookie = '', ffmpegPath = null) {
  const info = await extractViaYtDlp(parsedUrl.cleanUrl, { cookie, ffmpegPath });
  const rawFormats = Array.isArray(info.formats) ? info.formats : [];
  const videoStreams = [];
  const audioStreams = [];
  const progressiveStreams = [];

  for (const f of rawFormats) {
    if (!f.url) continue;
    const hasVideo = f.vcodec && f.vcodec !== 'none';
    const hasAudio = f.acodec && f.acodec !== 'none';
    if (hasVideo && hasAudio) {
      progressiveStreams.push({
        streamKey: `yt-prog-${f.format_id}`,
        streamKind: 'progressive_mp4',
        qn: f.height || 0,
        qualityLabel: f.height ? `${f.height}P` : f.format_note || 'HD',
        qualityDetail: `${f.format_note || ''} (yt-dlp)`.trim(),
        width: f.width || null,
        height: f.height || null,
        fps: f.fps || null,
        bitrateKbps: f.tbr ? Math.round(f.tbr) : null,
        codecKey: String(f.vcodec || '').startsWith('avc') ? 'avc' : 'other',
        codecName: f.vcodec || 'MP4',
        estimatedBytes: f.filesize || f.filesize_approx || null,
        hasAudio: true,
        requiresMerge: false,
        url: f.url,
        backupUrls: []
      });
    } else if (hasVideo) {
      videoStreams.push({
        streamKey: `yt-v-${f.format_id}`,
        streamKind: 'dash_video',
        qn: f.height || 0,
        qualityLabel: f.height ? `${f.height}P` : f.format_note || 'Video',
        qualityDetail: f.format_note || '',
        width: f.width || null,
        height: f.height || null,
        fps: f.fps || null,
        bitrateKbps: f.vbr ? Math.round(f.vbr) : null,
        codecKey: String(f.vcodec || '').startsWith('avc') ? 'avc' : String(f.vcodec || '').startsWith('hev') ? 'hevc' : 'other',
        codecName: f.vcodec || 'Video',
        estimatedBytes: f.filesize || f.filesize_approx || null,
        hasAudio: false,
        requiresMerge: true,
        url: f.url,
        backupUrls: []
      });
    } else if (hasAudio) {
      audioStreams.push({
        streamKey: `yt-a-${f.format_id}`,
        streamKind: 'dash_audio',
        audioId: f.format_id,
        label: f.abr ? `${Math.round(f.abr)} Kbps` : f.format_note || 'Audio',
        bitrateKbps: f.abr ? Math.round(f.abr) : null,
        codecsRaw: f.acodec || 'aac',
        ext: f.ext || 'm4a',
        estimatedBytes: f.filesize || f.filesize_approx || null,
        url: f.url,
        backupUrls: []
      });
    }
  }

  videoStreams.sort((a, b) => (b.height || 0) - (a.height || 0));
  audioStreams.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));

  return {
    contentType: 'bilibili_tv',
    bvid: null,
    aid: null,
    videoId: String(info.id || parsedUrl.videoId || 'bilibili_tv'),
    cid: null,
    title: info.title || 'Bilibili.tv Video',
    description: info.description || '',
    pubdate: info.timestamp || null,
    pubdateText: info.timestamp ? new Date(info.timestamp * 1000).toLocaleString('vi-VN') : null,
    author: info.uploader || info.channel || 'Bilibili.tv',
    authorMid: info.uploader_id ? String(info.uploader_id) : null,
    authorAvatar: '',
    cover: normalizeHttps(info.thumbnail || ''),
    duration: Math.round(info.duration || 0),
    stats: {
      views: info.view_count ?? null,
      likes: info.like_count ?? null,
      coins: null,
      favorites: null,
      shares: null,
      comments: info.comment_count ?? null,
      danmaku: null
    },
    pages: [],
    playlist: null,
    cleanUrl: parsedUrl.cleanUrl,
    embedUrl: null,
    streams: {
      videoStreams,
      audioStreams,
      progressiveStreams,
      lockedQualities: [],
      hasDash: videoStreams.length > 0,
      hasProgressive: progressiveStreams.length > 0,
      engine: 'yt-dlp Bilibili.tv Extractor'
    }
  };
}

/**
 * Lấy thông tin hồ sơ & danh sách video phân trang của 1 kênh UP chủ (Space).
 */
async function scanSpaceProfile({ input, page = 1, pageSize = 20, cookie = '' }) {
  const trimmed = String(input || '').trim();
  let mid = null;

  const mSpace = trimmed.match(/space\.bilibili\.com\/(\d+)/i);
  if (mSpace) mid = mSpace[1];
  else if (/^\d{2,16}$/.test(trimmed)) mid = trimmed;
  else {
    // Tìm theo tên kênh UP chủ
    const searchUrl = `https://api.bilibili.com/x/web-interface/search/type?search_type=bili_user&keyword=${encodeURIComponent(trimmed)}`;
    const sj = await fetchBilibiliJson(searchUrl, cookie, { referer: 'https://search.bilibili.com/' });
    const first = sj?.data?.result?.[0];
    if (first?.mid) mid = String(first.mid);
  }

  if (!mid) {
    throw new Error('Không xác định được UID (mid) của kênh Bilibili. Hãy nhập link dạng https://space.bilibili.com/123456 hoặc UID số.');
  }

  // 1. Lấy thẻ hồ sơ kênh (/x/web-interface/card) giống CNDownload
  const cardJson = await fetchBilibiliJson(`https://api.bilibili.com/x/web-interface/card?mid=${mid}`, cookie, {
    referer: `https://space.bilibili.com/${mid}/`
  }).catch(() => null);

  const card = cardJson?.data?.card;
  const profile = {
    mid,
    name: card?.name || `UID ${mid}`,
    avatar: normalizeHttps(card?.face || ''),
    sign: card?.sign || '',
    followers: cardJson?.data?.follower ?? null,
    archiveCount: cardJson?.data?.archive_count ?? null,
    profileUrl: `https://space.bilibili.com/${mid}/video`
  };

  // 2. Thử lấy danh sách upload qua WBI Space API trước (nhanh, không cần spawn yt-dlp)
  let items = [];
  let hasMore = false;
  let totalCount = profile.archiveCount;
  let usedMethod = 'WBI Space API';

  const wbiKeys = await getWbiKeys(cookie);
  if (wbiKeys) {
    const query = signWbiParams(
      { mid, ps: pageSize, tid: 0, pn: page, order: 'pubdate', platform: 'web' },
      wbiKeys.imgKey,
      wbiKeys.subKey
    );
    const arcUrl = `https://api.bilibili.com/x/space/wbi/arc/search?${query}`;
    const arcJson = await fetchBilibiliJson(arcUrl, cookie, {
      referer: `https://space.bilibili.com/${mid}/video`
    }).catch(() => null);

    if (arcJson && arcJson.code === 0 && arcJson.data?.list?.vlist) {
      const vlist = arcJson.data.list.vlist;
      totalCount = arcJson.data.page?.count ?? totalCount;
      items = vlist.map((v) => ({
        bvid: v.bvid,
        aid: String(v.aid),
        title: v.title,
        cover: normalizeHttps(v.pic || ''),
        duration: parseLengthStr(v.length),
        views: v.play ?? null,
        pubdate: v.created || null,
        pubdateText: v.created ? new Date(v.created * 1000).toLocaleDateString('vi-VN') : '',
        url: `https://www.bilibili.com/video/${v.bvid}`
      }));
      hasMore = page * pageSize < (totalCount || 0);
    }
  }

  // 3. Nếu Space WBI bị chặn (-352/-412), fallback sang yt-dlp giống CNDownload
  if (items.length === 0) {
    usedMethod = 'yt-dlp Space Extractor';
    const yRes = await fetchSpaceUploadsViaYtDlp({ mid, page, pageSize, cookie });
    if (!yRes.ok) {
      throw new Error(yRes.error || 'Không thể liệt kê video từ Space Bilibili.');
    }
    items = yRes.items.map((it) => ({
      ...it,
      cover: normalizeHttps(it.cover),
      pubdateText: it.pubdate ? new Date(it.pubdate * 1000).toLocaleDateString('vi-VN') : ''
    }));
    hasMore = yRes.hasMore;
    totalCount = yRes.totalCount || totalCount;
  }

  return {
    profile,
    page,
    pageSize,
    totalCount,
    hasMore,
    usedMethod,
    items
  };
}

function parseLengthStr(lenStr) {
  if (typeof lenStr === 'number') return lenStr;
  const parts = String(lenStr || '').split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

/**
 * Hàm phân tích tổng hợp đầu vào Bilibili cho giao diện chính.
 */
async function analyzeBilibiliUrl(rawInput, options = {}) {
  const cookie = options.cookie || '';
  const parsed = await parseBilibiliInput(rawInput, { cookie });

  if (parsed.contentType === 'space') {
    const spaceData = await scanSpaceProfile({ input: parsed.mid, page: 1, pageSize: 20, cookie });
    return {
      success: true,
      contentType: 'space',
      parsed,
      spaceData
    };
  }

  if (parsed.contentType === 'pgc') {
    const videoInfo = await fetchPgcInfo(parsed, cookie);
    return { success: true, contentType: 'pgc', parsed, data: videoInfo };
  }

  if (parsed.contentType === 'collection' || parsed.contentType === 'medialist') {
    const videoInfo = await fetchCollectionInfo(parsed, cookie);
    return { success: true, contentType: 'collection', parsed, data: videoInfo };
  }

  if (parsed.contentType === 'bilibili_tv') {
    const videoInfo = await fetchBilibiliTvInfo(parsed, cookie, options.ffmpegPath);
    return { success: true, contentType: 'bilibili_tv', parsed, data: videoInfo };
  }

  const videoInfo = await fetchStandardVideoInfo(parsed, cookie);
  return { success: true, contentType: 'video', parsed, data: videoInfo };
}

/**
 * Lấy lại chất lượng khi chọn phần khác (P2, P3...) hoặc khi URL stream hết hạn lúc Resume/Retry.
 */
async function fetchPartQualities({ bvid, aid, cid, epId, durationSec = 0, cookie = '' }) {
  return fetchPlayUrlQualities({ bvid, aid, cid, epId, durationSec, cookie });
}

module.exports = {
  normalizeHttps,
  fetchBilibiliJson,
  normalizePlayUrlStreams,
  fetchPlayUrlQualities,
  fetchStandardVideoInfo,
  fetchPgcInfo,
  fetchCollectionInfo,
  scanSpaceProfile,
  analyzeBilibiliUrl,
  fetchPartQualities
};
