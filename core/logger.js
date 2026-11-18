/**
 * Logger có kiểm soát bảo mật:
 * - Tự động che (redact) Cookie, SESSDATA, DedeUserID, bili_jct, token nhạy cảm trước khi in hoặc ghi file.
 * - Hỗ trợ xoay vòng file log (giữ dưới 2 MB) để không chiếm ổ đĩa người dùng.
 */

const fs = require('fs');
const path = require('path');

let logFilePath = null;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const recentLines = [];
const MAX_MEMORY_LINES = 300;

const SENSITIVE_KEYS = new Set([
  'cookie',
  'cookies',
  'set-cookie',
  'authorization',
  'sessdata',
  'bili_jct',
  'dedeuserid',
  'dedeuserid__ckmd5',
  'access_token',
  'refresh_token'
]);

function redactSensitiveText(input) {
  if (input === null || input === undefined) return '';
  let text = String(input);
  text = text.replace(/(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|ac_time_value)=([^;\s&]+)/gi, '$1=[REDACTED]');
  text = text.replace(/(Cookie\s*:\s*)([^\r\n]+)/gi, '$1[REDACTED]');
  return text;
}

function sanitizeObject(obj, depth = 0) {
  if (depth > 8 || obj === null || typeof obj !== 'object') {
    return typeof obj === 'string' ? redactSensitiveText(obj) : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObject(item, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(String(k).toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = sanitizeObject(v, depth + 1);
    }
  }
  return out;
}

function initLogger(logDir) {
  if (!logDir) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFilePath = path.join(logDir, 'bilidownloader.log');
  } catch {
    logFilePath = null;
  }
}

function writeLog(level, scope, message, extra = null) {
  const ts = new Date().toISOString();
  const safeMsg = redactSensitiveText(message);
  let line = `[${ts}] [${level.toUpperCase()}] [${scope}] ${safeMsg}`;
  if (extra) {
    try {
      const safeExtra = extra instanceof Error ? { message: redactSensitiveText(extra.message) } : sanitizeObject(extra);
      line += ` ${JSON.stringify(safeExtra)}`;
    } catch {}
  }

  recentLines.push(line);
  if (recentLines.length > MAX_MEMORY_LINES) recentLines.shift();

  if (logFilePath) {
    try {
      if (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > MAX_LOG_BYTES) {
        const prev = `${logFilePath}.1`;
        if (fs.existsSync(prev)) fs.unlinkSync(prev);
        fs.renameSync(logFilePath, prev);
      }
      fs.appendFileSync(logFilePath, line + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch {}
  }
  return line;
}

function getRecentLogs(limit = 100) {
  return recentLines.slice(-Math.max(1, limit));
}

function getLogFilePath() {
  return logFilePath;
}

module.exports = {
  initLogger,
  redactSensitiveText,
  sanitizeObject,
  info: (scope, msg, extra) => writeLog('info', scope, msg, extra),
  warn: (scope, msg, extra) => writeLog('warn', scope, msg, extra),
  error: (scope, msg, extra) => writeLog('error', scope, msg, extra),
  getRecentLogs,
  getLogFilePath
};
