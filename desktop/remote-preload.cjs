'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Only the current remote main frame receives this narrowly scoped capability.
if (process.isMainFrame && /^https?:$/.test(globalThis.location.protocol)) {
  contextBridge.exposeInMainWorld(
    'openbotVersion',
    Object.freeze({
      getVersion: () => ipcRenderer.invoke('openbot-client:get-version'),
    }),
  );
  contextBridge.exposeInMainWorld(
    'openbotAuthorization',
    Object.freeze({
      open: (request) => ipcRenderer.invoke('openbot-app:authorize', request),
    }),
  );
  contextBridge.exposeInMainWorld(
    'openbotFiles',
    Object.freeze({
      downloadSharedFile: (request) => ipcRenderer.invoke('openbot-files:download-shared', request),
    }),
  );
  contextBridge.exposeInMainWorld(
    'openbotNotifications',
    Object.freeze({
      permission: (scope) => ipcRenderer.invoke('openbot-notifications:permission', scope),
      requestPermission: (scope) =>
        ipcRenderer.invoke('openbot-notifications:requestPermission', scope),
      show: (notice) => ipcRenderer.invoke('openbot-notifications:show', notice),
      clear: (scope) => ipcRenderer.invoke('openbot-notifications:clear', scope),
    }),
  );
}
