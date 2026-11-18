/**
 * Điểm truy cập thống nhất của lõi BiliDownloader (Core API).
 */

const { OUTPUT_CONTAINERS, QUALITY_MAP, VIDEO_CODEC_MAP, AUDIO_QUALITY_MAP } = require('./constants');
const logger = require('./logger');
const { validateAndNormalizeCookie, isBilibiliCookieAllowedUrl } = require('./cookieStore');
const { parseBilibiliInput, classifyBilibiliUrl } = require('./urlParser');
const { analyzeBilibiliUrl, fetchPartQualities, scanSpaceProfile } = require('./bilibiliApi');
const { getFfmpegPath, probeMedia, muxOrConvertStreams } = require('./ffmpegService');
const { getYtDlpPath, isYtDlpAvailable } = require('./ytdlpFallback');
const { StorageStore } = require('./storageStore');
const { DownloadManager } = require('./downloadManager');

function createBiliCore({ userDataDir, logDir } = {}) {
  logger.initLogger(logDir || (userDataDir ? `${userDataDir}/logs` : null));
  const storage = new StorageStore(userDataDir);
  const downloadManager = new DownloadManager({
    storageStore: storage,
    getCookieFn: () => storage.getCookie()
  });

  return {
    constants: { OUTPUT_CONTAINERS, QUALITY_MAP, VIDEO_CODEC_MAP, AUDIO_QUALITY_MAP },
    logger,
    storage,
    downloadManager,
    ffmpegPath: getFfmpegPath(),
    ytdlpPath: getYtDlpPath(),
    isYtDlpAvailable: isYtDlpAvailable(),
    validateCookie: validateAndNormalizeCookie,
    isCookieAllowedUrl: isBilibiliCookieAllowedUrl,
    parseInput: parseBilibiliInput,
    classifyUrl: classifyBilibiliUrl,
    analyzeUrl: (rawInput) =>
      analyzeBilibiliUrl(rawInput, {
        cookie: storage.getCookie(),
        ffmpegPath: getFfmpegPath()
      }),
    fetchPartQualities: (params) =>
      fetchPartQualities({
        ...params,
        cookie: storage.getCookie()
      }),
    scanSpace: (params) =>
      scanSpaceProfile({
        ...params,
        cookie: storage.getCookie()
      }),
    probeMedia,
    muxOrConvertStreams
  };
}

module.exports = { createBiliCore };
