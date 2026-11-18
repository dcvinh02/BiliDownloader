const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('biliApi', {
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  chooseFolder: () => ipcRenderer.invoke('settings:chooseFolder'),

  getCookieStatus: () => ipcRenderer.invoke('cookie:getStatus'),
  saveCookie: (rawCookie) => ipcRenderer.invoke('cookie:save', rawCookie),
  clearCookie: () => ipcRenderer.invoke('cookie:clear'),

  analyzeUrl: (rawInput) => ipcRenderer.invoke('bilibili:analyze', rawInput),
  fetchPartQualities: (params) => ipcRenderer.invoke('bilibili:partQualities', params),
  scanSpace: (params) => ipcRenderer.invoke('bilibili:scanSpace', params),

  enqueueDownload: (task) => ipcRenderer.invoke('download:enqueue', task),
  enqueueBatchDownloads: (tasks) => ipcRenderer.invoke('download:enqueueBatch', tasks),
  listDownloads: () => ipcRenderer.invoke('download:list'),
  pauseDownload: (jobId) => ipcRenderer.invoke('download:pause', jobId),
  resumeDownload: (jobId) => ipcRenderer.invoke('download:resume', jobId),
  retryDownload: (jobId) => ipcRenderer.invoke('download:retry', jobId),
  cancelDownload: (jobId) => ipcRenderer.invoke('download:cancel', jobId),
  removeDownload: (jobId) => ipcRenderer.invoke('download:remove', jobId),
  onDownloadUpdate: (cb) => {
    const handler = (_, job) => cb(job);
    ipcRenderer.on('download:update', handler);
    return () => ipcRenderer.removeListener('download:update', handler);
  },

  listHistory: () => ipcRenderer.invoke('history:list'),
  removeHistory: (id, deleteFile) => ipcRenderer.invoke('history:remove', id, deleteFile),
  clearHistory: () => ipcRenderer.invoke('history:clear'),

  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showInFolder: (p) => ipcRenderer.invoke('shell:showInFolder', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  getRecentLogs: () => ipcRenderer.invoke('logs:recent')
});
