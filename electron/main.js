/**
 * Electron Main Process — BiliDownloader Desktop App (Windows 10/11 & macOS)
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { createBiliCore } = require('../core');
const { DESKTOP_UA, BILIBILI_REFERER } = require('../core/constants');

let mainWindow = null;
let mediaProxyServer = null;
let mediaProxyPort = 0;
let core = null;

// Đảm bảo chỉ chạy 1 cửa sổ ứng dụng cùng lúc (Single Instance)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function isAllowedMediaProxyHost(hostname = '') {
  const h = String(hostname || '').toLowerCase();
  const allowed = ['hdslb.com', 'bilivideo.com', 'bilivideo.cn', 'biliimg.com', 'bilibili.com'];
  return allowed.some((d) => h === d || h.endsWith(`.${d}`));
}

function startLocalMediaProxy() {
  return new Promise((resolve) => {
    mediaProxyServer = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://127.0.0.1:${mediaProxyPort}`);
        if (reqUrl.pathname !== '/proxy') {
          res.writeHead(404);
          return res.end('Not found');
        }
        const target = reqUrl.searchParams.get('url');
        if (!target || !/^https?:\/\//i.test(target)) {
          res.writeHead(400);
          return res.end('Bad URL');
        }
        const parsedTarget = new URL(target);
        if (!isAllowedMediaProxyHost(parsedTarget.hostname)) {
          res.writeHead(403);
          return res.end('Forbidden host');
        }

        const headers = {
          'User-Agent': DESKTOP_UA,
          Referer: reqUrl.searchParams.get('referer') || BILIBILI_REFERER
        };
        if (req.headers.range) headers.Range = req.headers.range;

        const upstream = await fetch(target, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(15000)
        });
        if (!upstream.ok && upstream.status !== 206) {
          res.writeHead(upstream.status);
          return res.end('Upstream error');
        }

        const outHeaders = {};
        for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
          const val = upstream.headers.get(h);
          if (val) outHeaders[h] = val;
        }
        res.writeHead(upstream.status, outHeaders);
        if (upstream.body) {
          Readable.fromWeb(upstream.body).pipe(res);
        } else {
          res.end();
        }
      } catch {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      }
    });

    mediaProxyServer.listen(0, '127.0.0.1', () => {
      mediaProxyPort = mediaProxyServer.address().port;
      resolve(mediaProxyPort);
    });
  });
}

function registerIpcHandlers() {
  // Forward trạng thái tiến độ tải xuống sang Renderer theo thời gian thực
  core.downloadManager.on('update', (job) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download:update', job);
    }
  });

  ipcMain.handle('app:getInfo', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    mediaProxyBase: `http://127.0.0.1:${mediaProxyPort}/proxy`,
    ffmpegPath: core.ffmpegPath,
    ffmpegExists: fs.existsSync(core.ffmpegPath) || !path.isAbsolute(core.ffmpegPath),
    ytdlpPath: core.ytdlpPath,
    logFile: core.logger.getLogFilePath()
  }));

  ipcMain.handle('settings:get', () => core.storage.getSettings());
  ipcMain.handle('settings:update', (_, patch) => core.storage.updateSettings(patch));
  ipcMain.handle('settings:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn thư mục lưu video Bilibili',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('cookie:getStatus', () => {
    const raw = core.storage.getCookie();
    const norm = core.validateCookie(raw);
    return {
      provided: norm.provided,
      valid: norm.valid,
      cookieCount: norm.cookieCount,
      hasSessData: norm.hasSessData,
      dedeUserId: norm.dedeUserId,
      message: norm.message
    };
  });

  ipcMain.handle('cookie:save', (_, rawCookie) => {
    const trimmed = String(rawCookie || '').trim();
    if (!trimmed) {
      core.storage.setCookie('');
      return core.validateCookie('');
    }
    const norm = core.validateCookie(trimmed);
    if (!norm.valid) {
      throw new Error(norm.message);
    }
    core.storage.setCookie(trimmed);
    core.logger.info('cookie', `Cập nhật Cookie người dùng (${norm.cookieCount} trường, SESSDATA=${norm.hasSessData})`);
    return {
      provided: norm.provided,
      valid: norm.valid,
      cookieCount: norm.cookieCount,
      hasSessData: norm.hasSessData,
      dedeUserId: norm.dedeUserId,
      message: norm.message
    };
  });

  ipcMain.handle('cookie:clear', () => {
    core.storage.setCookie('');
    core.logger.info('cookie', 'Đã xóa Cookie người dùng khỏi bộ nhớ cục bộ.');
    return core.validateCookie('');
  });

  ipcMain.handle('bilibili:analyze', async (_, rawInput) => {
    return await core.analyzeUrl(rawInput);
  });

  ipcMain.handle('bilibili:partQualities', async (_, params) => {
    return await core.fetchPartQualities(params);
  });

  ipcMain.handle('bilibili:scanSpace', async (_, params) => {
    return await core.scanSpace(params);
  });

  ipcMain.handle('download:enqueue', (_, task) => {
    return core.downloadManager.enqueue(task);
  });

  ipcMain.handle('download:enqueueBatch', (_, tasks) => {
    return (tasks || []).map((t) => core.downloadManager.enqueue(t));
  });

  ipcMain.handle('download:list', () => core.downloadManager.listJobs());
  ipcMain.handle('download:pause', (_, jobId) => core.downloadManager.pauseJob(jobId));
  ipcMain.handle('download:resume', (_, jobId) => core.downloadManager.resumeJob(jobId));
  ipcMain.handle('download:retry', (_, jobId) => core.downloadManager.retryJob(jobId));
  ipcMain.handle('download:cancel', (_, jobId) => core.downloadManager.cancelJob(jobId));
  ipcMain.handle('download:remove', (_, jobId) => core.downloadManager.removeJob(jobId));

  ipcMain.handle('history:list', () => core.storage.getHistory());
  ipcMain.handle('history:remove', (_, id, deleteFile) => core.storage.removeHistoryItem(id, Boolean(deleteFile)));
  ipcMain.handle('history:clear', () => {
    core.storage.clearHistory();
    return true;
  });

  ipcMain.handle('shell:openPath', async (_, targetPath) => {
    if (!targetPath || !fs.existsSync(targetPath)) return false;
    await shell.openPath(targetPath);
    return true;
  });

  ipcMain.handle('shell:showInFolder', (_, targetPath) => {
    if (!targetPath) return false;
    if (fs.existsSync(targetPath)) {
      shell.showItemInFolder(targetPath);
      return true;
    }
    const dir = path.dirname(targetPath);
    if (fs.existsSync(dir)) {
      shell.openPath(dir);
      return true;
    }
    return false;
  });

  ipcMain.handle('shell:openExternal', async (_, url) => {
    if (url && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('logs:recent', () => core.logger.getRecentLogs(120));
}

async function createMainWindow() {
  const userDataDir = app.getPath('userData');
  core = createBiliCore({
    userDataDir,
    logDir: path.join(userDataDir, 'logs')
  });

  await startLocalMediaProxy();
  registerIpcHandlers();

  const iconPath = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1020,
    minHeight: 680,
    title: `BiliDownloader v${app.getVersion()}`,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#11161f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await createMainWindow();
  // Chế độ tự kiểm tra đóng gói cho CI Windows (--smoke-test)
  if (process.argv.includes('--smoke-test')) {
    setTimeout(() => {
      console.log('SMOKE_TEST_OK');
      app.exit(0);
    }, 1800);
  }
});

app.on('window-all-closed', () => {
  if (mediaProxyServer) {
    try { mediaProxyServer.close(); } catch {}
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});
