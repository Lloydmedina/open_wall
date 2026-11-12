"use strict";

const { contextBridge, ipcRenderer } = require("electron");

async function unwrap(result) {
  const resolved = await result;
  if (resolved && resolved.error) throw new Error(resolved.error);
  return resolved;
}

const isLocalPage =
  location.protocol === "file:" || location.origin === "http://localhost:5175";

if (process.isMainFrame && isLocalPage) {
  contextBridge.exposeInMainWorld("electronWindow", {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onMaximized(callback) {
      const handler = (_event, maximized) => callback(maximized);
      ipcRenderer.on("window:maximized", handler);
      return () => ipcRenderer.removeListener("window:maximized", handler);
    },
  });

  contextBridge.exposeInMainWorld("electronWallpaper", {
    setImage: async (url) => {
      await unwrap(ipcRenderer.invoke("wallpaper:set-image", url));
    },
    setVideo: async (url) => {
      await unwrap(ipcRenderer.invoke("wallpaper:set-video", url));
    },
    stopVideo: async () => {
      await unwrap(ipcRenderer.invoke("wallpaper:stop-video"));
    },
    isVideoActive: () => ipcRenderer.invoke("wallpaper:is-video-active"),
    onVideoActive(callback) {
      const handler = (_event, active) => callback(active);
      ipcRenderer.on("wallpaper:video-active", handler);
      return () => ipcRenderer.removeListener("wallpaper:video-active", handler);
    },
    download: async (url, name) => {
      const resolved = await unwrap(
        ipcRenderer.invoke("wallpaper:download", url, name)
      );
      return { saved: resolved.saved === true };
    },
    listLocal: async (refresh) => {
      return await unwrap(
        ipcRenderer.invoke("wallpaper:list-local", refresh === true)
      );
    },
    addLocalFolder: async () => {
      return await unwrap(ipcRenderer.invoke("wallpaper:add-local-folder"));
    },
    addLocalFiles: async () => {
      return await unwrap(ipcRenderer.invoke("wallpaper:add-local-files"));
    },
    removeLocalPath: async (target) => {
      return await unwrap(
        ipcRenderer.invoke("wallpaper:remove-local-path", target)
      );
    },
    setLocalVideo: async (filePath) => {
      await unwrap(ipcRenderer.invoke("wallpaper:set-local-video", filePath));
    },
    setLocalImage: async (filePath) => {
      await unwrap(ipcRenderer.invoke("wallpaper:set-local-image", filePath));
    },
    onProgress(callback) {
      const handler = (_event, percent) => callback(percent);
      ipcRenderer.on("wallpaper:progress", handler);
      return () => ipcRenderer.removeListener("wallpaper:progress", handler);
    },
  });

  contextBridge.exposeInMainWorld("electronSettings", {
    getIcon: () => unwrap(ipcRenderer.invoke("settings:get-icon")),
    pickIcon: () => unwrap(ipcRenderer.invoke("settings:pick-icon")),
    resetIcon: () => unwrap(ipcRenderer.invoke("settings:reset-icon")),
    createShortcut: () =>
      unwrap(ipcRenderer.invoke("settings:create-shortcut")),
  });
}
