'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// This bridge belongs only to the packaged setup page, never the remote product view.
if (process.isMainFrame && globalThis.location.href === 'openbot-app://setup/') {
  contextBridge.exposeInMainWorld(
    'openbotDesktop',
    Object.freeze({
      setLanguage: (language) => {
        if (!['zh-CN', 'en'].includes(language)) throw new TypeError('Invalid client language');
        return ipcRenderer.invoke('openbot-client:set-language', language);
      },
      getState: () => ipcRenderer.invoke('openbot-client:get-state'),
      connect: ({ url } = {}) => ipcRenderer.invoke('openbot-client:connect', { url }),
      retry: () => ipcRenderer.invoke('openbot-client:retry'),
      startLocal: ({ hostControl = false } = {}) => {
        if (typeof hostControl !== 'boolean') throw new TypeError('Invalid computer access choice');
        return ipcRenderer.invoke('openbot-client:start-local', { hostControl });
      },
      cancelLocal: () => ipcRenderer.invoke('openbot-client:cancel-local'),
      onState: (callback) => {
        if (typeof callback !== 'function')
          throw new TypeError('State listener must be a function.');
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('openbot-client:state', listener);
        return () => ipcRenderer.removeListener('openbot-client:state', listener);
      },
    }),
  );
}
