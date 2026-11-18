/**
 * Quản lý cấu hình ứng dụng, Cookie lưu cục bộ và Lịch sử tải xuống (atomic JSON write).
 * - Tách biệt hoàn toàn với CNDownload.
 * - Khi ghi metadata hay lịch sử ra đĩa, không lưu chuỗi Cookie thô vào lịch sử công khai.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

class StorageStore {
  constructor(userDataDir) {
    this.baseDir = userDataDir || path.join(os.homedir(), '.bilidownloader');
    fs.mkdirSync(this.baseDir, { recursive: true });

    this.settingsPath = path.join(this.baseDir, 'settings.json');
    this.historyPath = path.join(this.baseDir, 'history.json');
    this.cookiePath = path.join(this.baseDir, 'cookie.dat');
    this.queuePath = path.join(this.baseDir, 'queue.json');

    this.defaultDownloadDir = path.join(os.homedir(), 'Downloads', 'BiliDownloader');
    this.settings = this._loadJson(this.settingsPath, {
      downloadDir: this.defaultDownloadDir,
      maxConcurrent: 2,
      theme: 'dark',
      defaultFormat: 'mp4',
      defaultCodecOrder: 'avc',
      saveCoverThumb: false,
      saveMetadataJson: true
    });

    // Đảm bảo thư mục tải tồn tại
    if (!this.settings.downloadDir) this.settings.downloadDir = this.defaultDownloadDir;
    try { fs.mkdirSync(this.settings.downloadDir, { recursive: true }); } catch {}

    this.history = this._loadJson(this.historyPath, []);
    if (!Array.isArray(this.history)) this.history = [];
  }

  _loadJson(filePath, fallback) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    } catch {}
    return fallback;
  }

  _saveJsonAtomic(filePath, data) {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(patch = {}) {
    const next = { ...this.settings, ...patch };
    if (next.maxConcurrent !== undefined) {
      next.maxConcurrent = Math.max(1, Math.min(5, Number(next.maxConcurrent) || 2));
    }
    if (next.downloadDir) {
      fs.mkdirSync(next.downloadDir, { recursive: true });
    }
    this.settings = next;
    this._saveJsonAtomic(this.settingsPath, this.settings);
    return this.getSettings();
  }

  getCookie() {
    try {
      if (fs.existsSync(this.cookiePath)) {
        return fs.readFileSync(this.cookiePath, 'utf8');
      }
    } catch {}
    return '';
  }

  setCookie(rawCookie = '') {
    const val = String(rawCookie || '').trim();
    if (!val) {
      if (fs.existsSync(this.cookiePath)) {
        try { fs.unlinkSync(this.cookiePath); } catch {}
      }
      return '';
    }
    fs.writeFileSync(this.cookiePath, val, { encoding: 'utf8', mode: 0o600 });
    return val;
  }

  getHistory() {
    return this.history.slice();
  }

  addHistoryItem(entry) {
    const item = {
      id: entry.id || `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      bvid: entry.bvid || '',
      title: entry.title || 'Bilibili Video',
      author: entry.author || '',
      thumbnail: entry.thumbnail || '',
      qualityLabel: entry.qualityLabel || '',
      codecName: entry.codecName || '',
      mode: entry.mode || 'video_audio',
      outputFormat: entry.outputFormat || 'mp4',
      fileSize: Number(entry.fileSize) || 0,
      duration: Number(entry.duration) || 0,
      outputPath: entry.outputPath || '',
      saveDir: entry.saveDir || '',
      sourceUrl: entry.sourceUrl || '',
      downloadedAt: entry.downloadedAt || new Date().toISOString()
    };
    this.history.unshift(item);
    if (this.history.length > 500) this.history = this.history.slice(0, 500);
    this._saveJsonAtomic(this.historyPath, this.history);
    return item;
  }

  removeHistoryItem(id, deleteFile = false) {
    const idx = this.history.findIndex((h) => h.id === id);
    if (idx >= 0) {
      const [removed] = this.history.splice(idx, 1);
      this._saveJsonAtomic(this.historyPath, this.history);
      if (deleteFile && removed?.outputPath && fs.existsSync(removed.outputPath)) {
        try { fs.unlinkSync(removed.outputPath); } catch {}
      }
      return true;
    }
    return false;
  }

  clearHistory() {
    this.history = [];
    this._saveJsonAtomic(this.historyPath, this.history);
  }
}

module.exports = { StorageStore };
