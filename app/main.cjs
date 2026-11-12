"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  nativeImage,
  Tray,
  Menu,
  dialog,
  net,
  shell,
} = require("electron");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { pathToFileURL } = require("url");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const execFileAsync = promisify(execFile);

const APP_NAME = "Open Wall";
const CACHE_DIR = "wallpapers";
const VIDEO_HTML = "video-wallpaper.html";
const ICON_FILE = "icon.png";
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const PS_TIMEOUT_MS = 30000;
const VIDEO_LOAD_TIMEOUT_MS = 15000;
const IMAGE_TYPES = { "image/jpeg": ".jpg", "image/png": ".png", "image/bmp": ".bmp" };
const VIDEO_TYPES = { "video/mp4": ".mp4", "video/webm": ".webm" };
const GENERIC_TYPES = ["application/octet-stream", "binary/octet-stream"];
const WALLPAPER_PATH_ENV = "WALLPAPER_IMAGE_PATH";
const VIDEO_HWNDS_ENV = "VIDEO_WALLPAPER_HWNDS";
const VIDEO_FAIL_MESSAGE = "The video cannot be played on this computer.";
const CUSTOM_ICON_FILE = "custom-icon.png";
const SHORTCUT_ICO_FILE = "app-icon.ico";
const LOCAL_LIBRARY_APP_ID = "431960";
const LOCAL_PATHS_FILE = "local-paths.json";
const LOCAL_VIDEO_EXTS = new Set([".mp4", ".webm"]);
const LOCAL_IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".bmp"]);

// --- PowerShell helpers -------------------------------------------------------

const PS_WALLPAPER_API = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class WallpaperNative {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SystemParametersInfo(int action, int param, string value, int flags);
}
'@
`;

const PS_SET_IMAGE =
  PS_WALLPAPER_API +
  `
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallpaperStyle -Value '10'
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name TileWallpaper -Value '0'
if (-not [WallpaperNative]::SystemParametersInfo(20, 0, $env:WALLPAPER_IMAGE_PATH, 3)) {
  throw 'Windows rejected the wallpaper image'
}
`;

const PS_MAKE_SHORTCUT = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($env:WALLPAPER_SHORTCUT_PATH)
$sc.TargetPath = $env:WALLPAPER_SHORTCUT_TARGET
$sc.WorkingDirectory = $env:WALLPAPER_SHORTCUT_WORKDIR
$sc.IconLocation = $env:WALLPAPER_SHORTCUT_ICON + ',0'
$sc.Save()
`;

const PS_REPAINT =
  PS_WALLPAPER_API +
  `
$current = (Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name Wallpaper).Wallpaper
if ($current) {
  [void][WallpaperNative]::SystemParametersInfo(20, 0, $current, 3)
}
`;

const PS_ATTACH_VIDEO = `
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class VideoWallpaperNative {
  const long WS_POPUP = 0x80000000L;
  const long WS_CHILD = 0x40000000L;
  const long WS_EX_LAYERED = 0x80000L;
  const long FRAME_STYLES = 0xC00000L | 0x40000L | 0x80000L | 0x20000L | 0x10000L;
  const long FRAME_EX_STYLES = 0x1L | 0x100L | 0x200L | 0x20000L;
  const int GWL_STYLE = -16;
  const int GWL_EXSTYLE = -20;
  const uint SWP_NOZORDER = 0x4;
  const uint SWP_NOACTIVATE = 0x10;
  const uint SWP_FRAMECHANGED = 0x20;
  const uint LWA_ALPHA = 0x2;

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  delegate bool MonitorEnumProc(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr window, ref POINT point);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr64(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetWindowLongPtr64(IntPtr window, int index, IntPtr value);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong32(IntPtr window, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetWindowLong32(IntPtr window, int index, int value);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr window, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  static IntPtr defView;

  static IntPtr GetWindowLongPtr(IntPtr window, int index) {
    return IntPtr.Size == 8 ? GetWindowLongPtr64(window, index) : new IntPtr(GetWindowLong32(window, index));
  }

  static IntPtr SetWindowLongPtr(IntPtr window, int index, IntPtr value) {
    return IntPtr.Size == 8 ? SetWindowLongPtr64(window, index, value) : new IntPtr(SetWindowLong32(window, index, value.ToInt32()));
  }

  static IntPtr FindDesktopLayer(IntPtr progman, out bool raised) {
    defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
    raised = defView != IntPtr.Zero;
    if (raised) return progman;
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr top, IntPtr data) {
      if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) {
        IntPtr layer = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
        if (layer != IntPtr.Zero) found = layer;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static string Attach(long[] handles) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch (EntryPointNotFoundException) { SetProcessDPIAware(); }

    IntPtr progman = FindWindow("Progman", null);
    if (progman == IntPtr.Zero) throw new InvalidOperationException("The desktop window was not found.");
    UIntPtr ignored;
    SendMessageTimeout(progman, 0x052C, new UIntPtr(0xD), new IntPtr(1), 0, 1000, out ignored);
    bool raised;
    IntPtr layer = FindDesktopLayer(progman, out raised);
    if (layer == IntPtr.Zero) {
      SendMessageTimeout(progman, 0x052C, UIntPtr.Zero, IntPtr.Zero, 0, 1000, out ignored);
      layer = FindDesktopLayer(progman, out raised);
    }
    if (layer == IntPtr.Zero) throw new InvalidOperationException("The desktop wallpaper layer was not found.");

    List<RECT> monitors = new List<RECT>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr dc, ref RECT rect, IntPtr data) {
      monitors.Add(rect);
      return true;
    }, IntPtr.Zero);
    if (monitors.Count == 0) throw new InvalidOperationException("No monitor was found.");

    for (int i = 0; i < handles.Length; i++) {
      IntPtr window = new IntPtr(handles[i]);
      RECT area = monitors[i % monitors.Count];

      long style = GetWindowLongPtr(window, GWL_STYLE).ToInt64();
      SetWindowLongPtr(window, GWL_STYLE, new IntPtr((style & ~(WS_POPUP | FRAME_STYLES)) | WS_CHILD));
      long extended = GetWindowLongPtr(window, GWL_EXSTYLE).ToInt64() & ~FRAME_EX_STYLES;
      if (raised) extended |= WS_EX_LAYERED;
      SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(extended));
      if (raised) SetLayeredWindowAttributes(window, 0, 255, LWA_ALPHA);
      SetParent(window, layer);
      if (GetParent(window) != layer) throw new InvalidOperationException("Could not attach the video window to the desktop.");

      POINT origin; origin.X = area.Left; origin.Y = area.Top;
      ScreenToClient(layer, ref origin);
      uint flags = SWP_NOACTIVATE | SWP_FRAMECHANGED;
      if (!raised) flags |= SWP_NOZORDER;
      SetWindowPos(window, raised ? defView : IntPtr.Zero, origin.X, origin.Y, area.Right - area.Left, area.Bottom - area.Top, flags);
    }
    return raised ? "raised" : "classic";
  }
}
'@
[VideoWallpaperNative]::Attach([long[]]($env:VIDEO_WALLPAPER_HWNDS -split ',' | ForEach-Object { [long]$_ }))
`;

const VIDEO_READY_CHECK =
  "new Promise(function (resolve) {" +
  "var video = document.querySelector('video');" +
  "var fail = function () { resolve(" +
  JSON.stringify(VIDEO_FAIL_MESSAGE) +
  "); };" +
  "if (video.error) return fail();" +
  "if (video.readyState >= 2) return resolve('');" +
  "video.addEventListener('loadeddata', function () { resolve(''); }, { once: true });" +
  "video.addEventListener('error', fail, { once: true });" +
  "setTimeout(function () { resolve('The video took too long to load.'); }, " +
  VIDEO_LOAD_TIMEOUT_MS +
  ");" +
  "})";

function videoPageHtml(videoSrc) {
  return (
    '<!doctype html>\n<meta charset="utf-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src file:; style-src \'unsafe-inline\'">\n' +
    "<style>\n" +
    "  html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }\n" +
    "  video { display: block; width: 100%; height: 100%; object-fit: cover; }\n" +
    "</style>\n" +
    '<video src="' +
    videoSrc +
    '" autoplay loop muted playsinline></video>\n'
  );
}

// --- small utilities ----------------------------------------------------------

const userDataDir = path.join(app.getPath("appData"), "open-wall");
app.setPath("userData", userDataDir);
app.setName(APP_NAME);

const logFile = path.join(userDataDir, "app.log");
function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.appendFileSync(logFile, line, () => {});
  console.log(message);
}

const fileExists = (p) => fsp.access(p).then(() => true, () => false);
const deleteQuiet = (p) => fsp.unlink(p).catch(() => undefined);
const errorText = (e) => (e instanceof Error ? e.message : String(e));

function powershellExe() {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
}

function runPowerShell(script, extraEnv) {
  const wrapped =
    "\n$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\ntry {\n" +
    script +
    "\n} catch {\n  [Console]::Error.WriteLine($_.Exception.Message)\n  exit 1\n}\n";
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      powershellExe(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-OutputFormat",
        "Text",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encoded,
      ],
      {
        windowsHide: true,
        timeout: PS_TIMEOUT_MS,
        env: { ...process.env, ...extraEnv },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout.trim());
        reject(
          new Error(
            stderr.trim() ||
              `PowerShell failed (${error.killed ? "timeout" : error.code ?? "spawn error"})`
          )
        );
      }
    );
  });
}

// --- app icon ------------------------------------------------------------------

const customIconPath = () =>
  path.join(app.getPath("userData"), CUSTOM_ICON_FILE);
const defaultIconPath = () => path.join(__dirname, ICON_FILE);

function effectiveIconPath() {
  const custom = customIconPath();
  return fs.existsSync(custom) ? custom : defaultIconPath();
}

function applyIconToWindows() {
  const img = nativeImage.createFromPath(effectiveIconPath());
  if (img.isEmpty()) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setIcon(img);
  }
  if (tray) tray.setImage(img.resize({ width: 16, height: 16 }));
}

function iconDataUrl() {
  try {
    const png = nativeImage.createFromPath(effectiveIconPath()).toPNG();
    return "data:image/png;base64," + png.toString("base64");
  } catch {
    return null;
  }
}

async function writeIcoFile(image, icoPath) {
  let img = image;
  const size = img.getSize();
  if (size.width > 256 || size.height > 256) {
    img = img.resize({ width: 256, height: 256 });
  }
  const png = img.toPNG();
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(w >= 256 ? 0 : w, 6);
  header.writeUInt8(h >= 256 ? 0 : h, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await fsp.writeFile(icoPath, Buffer.concat([header, png]));
}

// --- downloading ---------------------------------------------------------------

function assertHttps(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid file address.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only https:// addresses are allowed.");
  }
}

function firstHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw == null ? "" : raw;
}

function downloadTo(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    assertHttps(url);
    const request = net.request({ url });
    let stream;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      request.abort();
      if (stream && !stream.destroyed) {
        stream.once("close", () => reject(err));
        stream.destroy();
      } else {
        reject(err);
      }
    };

    request.on("error", fail);
    request.on("response", (response) => {
      const status = response.statusCode;
      if (status < 200 || status >= 300) {
        return fail(new Error(`Download failed (HTTP ${status}).`));
      }
      const contentType = firstHeader(response.headers["content-type"])
        .split(";")[0]
        .trim()
        .toLowerCase();
      const allowed =
        contentType.startsWith("image/") ||
        contentType.startsWith("video/") ||
        GENERIC_TYPES.includes(contentType);
      if (!allowed) {
        return fail(new Error("The address does not point to an image or video."));
      }
      const total = Number(firstHeader(response.headers["content-length"])) || 0;
      if (total > MAX_DOWNLOAD_BYTES) {
        return fail(new Error("The file is too large."));
      }

      const out = fs.createWriteStream(destPath);
      stream = out;
      let received = 0;
      let lastPercent = -1;
      out.on("error", fail);
      response.on("data", (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          return fail(new Error("The file is too large."));
        }
        out.write(chunk);
        const percent = total ? Math.min(100, Math.floor((received * 100) / total)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          if (onProgress) onProgress(percent);
        }
      });
      response.on("error", fail);
      response.on("aborted", () => fail(new Error("The download was interrupted.")));
      response.on("end", () => {
        if (settled) return;
        settled = true;
        out.end(() => resolve(contentType));
      });
    });
    request.end();
  });
}

let downloadBusy = false;
async function singleDownload(task) {
  if (downloadBusy) throw new Error("Another download is still in progress.");
  downloadBusy = true;
  try {
    return await task();
  } finally {
    downloadBusy = false;
  }
}

function urlExtension(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext === ".jpeg" ? ".jpg" : ext;
  } catch {
    return "";
  }
}

async function fetchMedia(url, typeMap, typeError, onProgress) {
  const cacheDir = path.join(app.getPath("userData"), CACHE_DIR);
  await fsp.mkdir(cacheDir, { recursive: true });
  const key = path.join(cacheDir, crypto.createHash("sha1").update(url).digest("hex"));

  for (const ext of Object.values(typeMap)) {
    if (await fileExists(key + ext)) return key + ext;
  }

  const part = key + ".part";
  try {
    const contentType = await downloadTo(url, part, onProgress);
    const ext =
      typeMap[contentType] ??
      (Object.values(typeMap).includes(urlExtension(url)) ? urlExtension(url) : undefined);
    if (!ext) throw new Error(typeError);
    await fsp.rename(part, key + ext);
    return key + ext;
  } catch (err) {
    await deleteQuiet(part);
    throw err;
  }
}

const fetchImage = (url, onProgress) =>
  singleDownload(() =>
    fetchMedia(url, IMAGE_TYPES, "Only JPG, PNG and BMP images can be set as wallpaper.", onProgress)
  );
const fetchVideo = (url, onProgress) =>
  singleDownload(() =>
    fetchMedia(url, VIDEO_TYPES, "Only MP4 and WebM videos can be set as wallpaper.", onProgress)
  );

// --- Local wallpaper library -------------------------------------------------------

let localDirsPromise = null;

async function localLibraryRoots() {
  const roots = new Set([
    path.join(
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
      "Steam"
    ),
  ]);
  try {
    const { stdout } = await execFileAsync(
      "reg.exe",
      ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
      { timeout: PS_TIMEOUT_MS, windowsHide: true }
    );
    const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout);
    if (match) roots.add(match[1].trim());
  } catch {}
  for (const root of [...roots]) {
    try {
      const vdf = await fsp.readFile(
        path.join(root, "steamapps", "libraryfolders.vdf"),
        "utf8"
      );
      for (const m of vdf.matchAll(/"path"\s*"((?:[^"\\]|\\.)*)"/g)) {
        roots.add(m[1].replace(/\\\\/g, "\\"));
      }
    } catch {}
  }
  return roots;
}

const customPathsFile = () =>
  path.join(app.getPath("userData"), LOCAL_PATHS_FILE);

async function readCustomPaths() {
  try {
    const data = JSON.parse(await fsp.readFile(customPathsFile(), "utf8"));
    const paths = Array.isArray(data.paths) ? data.paths : [];
    return paths.filter(
      (p) => typeof p === "string" && p && path.isAbsolute(p)
    );
  } catch {
    return [];
  }
}

async function writeCustomPaths(paths) {
  await fsp.mkdir(app.getPath("userData"), { recursive: true });
  await fsp.writeFile(customPathsFile(), JSON.stringify({ paths }));
}

async function addCustomPaths(newPaths) {
  const current = await readCustomPaths();
  const seen = new Set(current.map((p) => path.resolve(p)));
  for (const p of newPaths) {
    const resolved = path.resolve(String(p));
    if (!seen.has(resolved)) {
      seen.add(resolved);
      current.push(resolved);
    }
  }
  await writeCustomPaths(current);
  return current;
}

async function removeCustomPath(target) {
  const resolved = path.resolve(String(target));
  const next = (await readCustomPaths()).filter(
    (p) => path.resolve(p) !== resolved
  );
  await writeCustomPaths(next);
  return next;
}

function findLocalDirs() {
  if (!localDirsPromise) {
    localDirsPromise = (async () => {
      const found = [];
      for (const root of await localLibraryRoots()) {
        const dir = path.join(
          root,
          "steamapps",
          "workshop",
          "content",
          LOCAL_LIBRARY_APP_ID
        );
        if (await fileExists(dir)) found.push(dir);
      }
      return found;
    })();
  }
  return localDirsPromise;
}

const pickFile = (dirEntries, fileName, exts) => {
  const name = String(fileName ?? "").toLowerCase();
  if (!name) return null;
  const found = dirEntries.find((n) => n.toLowerCase() === name);
  return found && exts.has(path.extname(found).toLowerCase()) ? found : null;
};

function fileItem(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const isVideo = LOCAL_VIDEO_EXTS.has(ext);
  const isImage = LOCAL_IMAGE_EXTS.has(ext);
  if (!isVideo && !isImage) return null;
  return {
    id: filePath,
    title: path.basename(filePath, path.extname(filePath)),
    type: isVideo ? "video" : "image",
    previewUrl: isImage ? pathToFileURL(filePath).href : null,
    videoUrl: isVideo ? pathToFileURL(filePath).href : null,
    videoPath: isVideo ? filePath : null,
    imagePath: isImage ? filePath : null,
  };
}

async function readLocalItem(itemDir, id, loose = false) {
  let meta = {};
  try {
    meta = JSON.parse(
      await fsp.readFile(path.join(itemDir, "project.json"), "utf8")
    );
  } catch {}
  let names;
  try {
    names = await fsp.readdir(itemDir);
  } catch {
    return null;
  }

  const previewName =
    names.find((n) => n.toLowerCase() === String(meta.preview ?? "").toLowerCase()) ??
    names.find((n) => /^preview\.(jpe?g|png|bmp|gif)$/i.test(n)) ??
    (loose
      ? names.find((n) => LOCAL_IMAGE_EXTS.has(path.extname(n).toLowerCase()))
      : undefined);
  const previewPath = previewName ? path.join(itemDir, previewName) : null;

  let videoPath = null;
  if (meta.type === "video" || loose) {
    const file =
      pickFile(names, meta.file, LOCAL_VIDEO_EXTS) ??
      names.find((n) => LOCAL_VIDEO_EXTS.has(path.extname(n).toLowerCase()));
    if (file) videoPath = path.join(itemDir, file);
  }
  const imagePath =
    previewPath && LOCAL_IMAGE_EXTS.has(path.extname(previewPath).toLowerCase())
      ? previewPath
      : null;

  return {
    id,
    title: String(meta.title || id),
    type: String(
      meta.type || (videoPath ? "video" : imagePath ? "image" : "unknown")
    ),
    previewUrl: previewPath ? pathToFileURL(previewPath).href : null,
    videoUrl: videoPath ? pathToFileURL(videoPath).href : null,
    videoPath,
    imagePath,
  };
}

async function listLocalWallpapers(refresh) {
  if (refresh) localDirsPromise = null;
  const dirs = [...(await findLocalDirs())];
  const customPaths = await readCustomPaths();
  const customDirs = new Set();
  const customFiles = [];
  for (const p of customPaths) {
    try {
      const stat = await fsp.stat(p);
      if (stat.isDirectory()) {
        dirs.push(p);
        customDirs.add(p);
      } else if (stat.isFile()) {
        customFiles.push(p);
      }
    } catch {}
  }

  const items = [];
  const seen = new Set();
  for (const dir of dirs) {
    const loose = customDirs.has(dir);
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const key = loose ? fullPath : entry.name;
        if (seen.has(key)) continue;
        seen.add(key);
        const item = await readLocalItem(fullPath, entry.name, loose);
        if (item) items.push(item);
      } else if (loose && entry.isFile()) {
        const item = fileItem(fullPath);
        if (item) items.push(item);
      }
    }
  }
  for (const file of customFiles) {
    const item = fileItem(file);
    if (item) items.push(item);
  }
  items.sort(
    (a, b) =>
      Number(Boolean(b.videoPath)) - Number(Boolean(a.videoPath)) ||
      a.title.localeCompare(b.title)
  );
  return { dirs, customPaths, items };
}

async function assertLocalMediaPath(filePath, exts) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("Invalid file path.");
  }
  if (!exts.has(path.extname(filePath).toLowerCase())) {
    throw new Error("This file type is not supported.");
  }
  const resolved = path.resolve(filePath);
  const roots = [...(await findLocalDirs()), ...(await readCustomPaths())];
  const inside = roots.some((root) => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
  if (!inside) {
    throw new Error("File must be inside a local library folder.");
  }
  if (!(await fileExists(resolved))) throw new Error("File not found.");
  return resolved;
}

// --- wallpaper state ------------------------------------------------------------

let mainWindow = null;
let tray = null;
let videoWindows = [];
let hiddenForVideo = false;
let isQuitting = false;
let stoppingVideo = false;
let onVideoChange = null;

const isVideoActive = () => videoWindows.length > 0;

function destroyVideoWindows() {
  const wins = videoWindows;
  videoWindows = [];
  for (const win of wins) {
    if (!win.isDestroyed()) win.destroy();
  }
  if (wins.length > 0 && onVideoChange) onVideoChange();
}

async function stopVideo() {
  stoppingVideo = true;
  destroyVideoWindows();
  await repaintWallpaper();
  stoppingVideo = false;
  if (hiddenForVideo) app.quit();
}

async function setImageWallpaper(imagePath) {
  await runPowerShell(PS_SET_IMAGE, { [WALLPAPER_PATH_ENV]: imagePath });
}

async function repaintWallpaper() {
  try {
    await runPowerShell(PS_REPAINT, {});
  } catch (err) {
    log(`Restoring wallpaper failed: ${errorText(err)}`);
  }
}

function createVideoWindow(bounds) {
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    thickFrame: false,
    backgroundColor: "#000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  return win;
}

async function attachVideoWallpaper(videoPath, options = {}) {
  destroyVideoWindows();
  const htmlDir = options.htmlDir ?? path.dirname(videoPath);
  const videoSrc = options.src ?? encodeURIComponent(path.basename(videoPath));
  const htmlPath = path.join(htmlDir, VIDEO_HTML);
  await fsp.writeFile(htmlPath, videoPageHtml(videoSrc));

  const wins = screen
    .getAllDisplays()
    .map((display) => createVideoWindow(display.bounds));

  try {
    await Promise.all(
      wins.map(async (win) => {
        await win.loadFile(htmlPath);
        const error = await win.webContents.executeJavaScript(VIDEO_READY_CHECK);
        if (error) throw new Error(error);
      })
    );
    const handles = wins.map((win) => win.getNativeWindowHandle().readUInt32LE(0));
    const layout = await runPowerShell(PS_ATTACH_VIDEO, {
      [VIDEO_HWNDS_ENV]: handles.join(","),
    });
    log(`Video wallpaper attached (${layout})`);
    for (const win of wins) {
      win.showInactive();
      void win.webContents
        .executeJavaScript("document.querySelector('video').play()")
        .catch(() => {});
      win.on("closed", () => {
        if (videoWindows.includes(win)) destroyVideoWindows();
      });
    }
  } catch (err) {
    for (const win of wins) {
      if (!win.isDestroyed()) win.destroy();
    }
    throw err;
  }

  videoWindows = wins;
  if (onVideoChange) onVideoChange();
}

// --- main window + tray ----------------------------------------------------------

function mainWindowSize() {
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const pick = (total, max, min) =>
    Math.min(total, Math.max(min, Math.min(Math.round(total * 0.9), max)));
  const width = pick(workArea.width, 1700, 1200);
  const height = pick(workArea.height, 956, 675);
  return {
    width,
    height,
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
  };
}

function createMainWindow() {
  const win = new BrowserWindow({
    title: APP_NAME,
    ...mainWindowSize(),
    minWidth: 1200,
    minHeight: 675,
    frame: false,
    hasShadow: true,
    resizable: true,
    backgroundColor: "#0b0f1a",
    icon: nativeImage.createFromPath(effectiveIconPath()),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      nodeIntegrationInSubFrames: false,
    },
  });

  const contents = win.webContents;
  const sendMaximized = (maximized) => {
    if (!contents.isDestroyed()) contents.send("window:maximized", maximized);
  };

  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("ready-to-show", () => win.show());
  contents.once("did-finish-load", () => {
    if (!win.isVisible()) win.show();
  });
  win.on("maximize", () => sendMaximized(true));
  win.on("unmaximize", () => sendMaximized(false));
  win.on("close", (event) => {
    if (isQuitting || !isVideoActive()) return;
    event.preventDefault();
    hiddenForVideo = true;
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  const localFile = (url) => {
    try {
      return new URL(url).protocol === "file:";
    } catch {
      return false;
    }
  };
  contents.on("will-navigate", (event, url) => {
    if (!localFile(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!localFile(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());

  void win
    .loadFile(path.join(__dirname, "renderer", "index.html"))
    .catch((err) => log(`Page load failed: ${err.message}`));

  mainWindow = win;
  return win;
}

function showApp() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  hiddenForVideo = false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function onVideoActiveChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("wallpaper:video-active", isVideoActive());
  }
  if (!isVideoActive()) {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    if (hiddenForVideo && !isQuitting && !stoppingVideo) {
      void repaintWallpaper().then(() => app.quit());
    }
    return;
  }
  if (tray) return;
  const image = nativeImage
    .createFromPath(effectiveIconPath())
    .resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show app", click: showApp },
      { label: "Stop video wallpaper", click: () => void stopVideo() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ])
  );
  tray.on("click", showApp);
}

// --- IPC -----------------------------------------------------------------------

function assertLocalSender(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win !== mainWindow) {
    throw new Error("This action is available only to the local app page");
  }
  let protocol = "";
  try {
    protocol = new URL(event.sender.getURL()).protocol;
  } catch {}
  if (protocol !== "file:") {
    throw new Error("This action is available only to the local app page");
  }
}

function sendProgress(webContents, percent) {
  if (!webContents.isDestroyed()) webContents.send("wallpaper:progress", percent);
}

for (const action of ["minimize", "toggle-maximize", "close", "is-maximized"]) {
  ipcMain.handle(`window:${action}`, (event) => {
    assertLocalSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    switch (action) {
      case "minimize":
        win.minimize();
        return;
      case "toggle-maximize":
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return;
      case "close":
        win.close();
        return;
      case "is-maximized":
        return win.isMaximized();
    }
  });
}

ipcMain.handle("wallpaper:set-image", async (event, url) => {
  assertLocalSender(event);
  if (typeof url !== "string") return { error: "Invalid file address." };
  const sender = event.sender;
  try {
    const file = await fetchImage(url, (p) => sendProgress(sender, p));
    destroyVideoWindows();
    await setImageWallpaper(file);
    return {};
  } catch (err) {
    log(`Set wallpaper failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("wallpaper:set-video", async (event, url) => {
  assertLocalSender(event);
  if (typeof url !== "string") return { error: "Invalid file address." };
  const sender = event.sender;
  try {
    const file = await fetchVideo(url, (p) => sendProgress(sender, p));
    await attachVideoWallpaper(file);
    return {};
  } catch (err) {
    log(`Set video wallpaper failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("wallpaper:stop-video", async (event) => {
  assertLocalSender(event);
  await stopVideo();
  return {};
});

ipcMain.handle("wallpaper:is-video-active", (event) => {
  assertLocalSender(event);
  return isVideoActive();
});

ipcMain.handle("wallpaper:download", async (event, url, name) => {
  assertLocalSender(event);
  return singleDownload(async () => {
    assertHttps(url);
    const fileName = String(name ?? "").replace(/[\\/:*?"<>|]/g, "_");
    const ext = path.extname(fileName).slice(1);
    const win = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("downloads"), fileName),
      filters: ext
        ? [
            { name: ext.toUpperCase(), extensions: [ext] },
            { name: "All files", extensions: ["*"] },
          ]
        : [{ name: "All files", extensions: ["*"] }],
    });
    if (canceled || !filePath) return { saved: false };
    const part = filePath + ".part";
    try {
      await downloadTo(url, part, (p) => sendProgress(event.sender, p));
      await fsp.rename(part, filePath);
    } catch (err) {
      await deleteQuiet(part);
      throw err;
    }
    return { saved: true };
  }).catch((err) => ({ error: errorText(err) }));
});

ipcMain.handle("wallpaper:list-local", async (event, refresh) => {
  assertLocalSender(event);
  try {
    return await listLocalWallpapers(refresh === true);
  } catch (err) {
    log(`Local library scan failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("wallpaper:add-local-folder", async (event) => {
  assertLocalSender(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose folders to scan",
    properties: ["openDirectory", "multiSelections", "dontAddToRecent"],
  });
  if (canceled || !filePaths.length) return { added: 0 };
  try {
    const paths = await addCustomPaths(filePaths);
    return { added: filePaths.length, paths };
  } catch (err) {
    log(`Add local folder failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("wallpaper:add-local-files", async (event) => {
  assertLocalSender(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose wallpaper files",
    filters: [
      { name: "Media", extensions: ["mp4", "webm", "jpg", "jpeg", "png", "bmp"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile", "multiSelections", "dontAddToRecent"],
  });
  if (canceled || !filePaths.length) return { added: 0 };
  try {
    const media = filePaths.filter((p) => {
      const ext = path.extname(p).toLowerCase();
      return LOCAL_VIDEO_EXTS.has(ext) || LOCAL_IMAGE_EXTS.has(ext);
    });
    const paths = await addCustomPaths(media);
    return { added: media.length, paths };
  } catch (err) {
    log(`Add local files failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("wallpaper:remove-local-path", async (event, target) => {
  assertLocalSender(event);
  if (typeof target !== "string" || !path.isAbsolute(target)) {
    return { error: "Invalid path." };
  }
  try {
    const paths = await removeCustomPath(target);
    return { paths };
  } catch (err) {
    log(`Remove local path failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("wallpaper:set-local-video", async (event, filePath) => {
  assertLocalSender(event);
  try {
    const resolved = await assertLocalMediaPath(filePath, LOCAL_VIDEO_EXTS);
    const cacheDir = path.join(app.getPath("userData"), CACHE_DIR);
    await fsp.mkdir(cacheDir, { recursive: true });
    await attachVideoWallpaper(resolved, {
      htmlDir: cacheDir,
      src: pathToFileURL(resolved).href,
    });
    return {};
  } catch (err) {
    log(`Set local video failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("wallpaper:set-local-image", async (event, filePath) => {
  assertLocalSender(event);
  try {
    const resolved = await assertLocalMediaPath(filePath, LOCAL_IMAGE_EXTS);
    destroyVideoWindows();
    await setImageWallpaper(resolved);
    return {};
  } catch (err) {
    log(`Set local image failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("settings:get-icon", (event) => {
  assertLocalSender(event);
  return {
    iconUrl: iconDataUrl(),
    custom: fs.existsSync(customIconPath()),
  };
});

ipcMain.handle("settings:pick-icon", async (event) => {
  assertLocalSender(event);
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose an icon",
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "webp", "ico"] },
      { name: "All files", extensions: ["*"] },
    ],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return { changed: false };
  try {
    let img = nativeImage.createFromPath(filePaths[0]);
    if (img.isEmpty()) throw new Error("That file is not a usable image.");
    const size = img.getSize();
    if (size.width > 256 || size.height > 256) {
      img = img.resize({ width: 256, height: 256 });
    }
    await fsp.writeFile(customIconPath(), img.toPNG());
    applyIconToWindows();
    log(`App icon changed to ${filePaths[0]}`);
    return { changed: true, iconUrl: iconDataUrl() };
  } catch (err) {
    log(`Set app icon failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

ipcMain.handle("settings:reset-icon", async (event) => {
  assertLocalSender(event);
  try {
    await deleteQuiet(customIconPath());
    applyIconToWindows();
    return { iconUrl: iconDataUrl() };
  } catch (err) {
    return { error: errorText(err) };
  }
});

ipcMain.handle("settings:create-shortcut", async (event) => {
  assertLocalSender(event);
  try {
    const icoPath = path.join(app.getPath("userData"), SHORTCUT_ICO_FILE);
    await writeIcoFile(
      nativeImage.createFromPath(effectiveIconPath()),
      icoPath
    );
    const target = app.isPackaged
      ? process.execPath
      : path.join(__dirname, "..", "run.bat");
    const shortcutPath = path.join(
      app.getPath("desktop"),
      `${APP_NAME}.lnk`
    );
    await runPowerShell(PS_MAKE_SHORTCUT, {
      WALLPAPER_SHORTCUT_PATH: shortcutPath,
      WALLPAPER_SHORTCUT_TARGET: target,
      WALLPAPER_SHORTCUT_WORKDIR: path.dirname(target),
      WALLPAPER_SHORTCUT_ICON: icoPath,
    });
    log(`Desktop shortcut created: ${shortcutPath}`);
    return { shortcutPath };
  } catch (err) {
    log(`Create shortcut failed: ${errorText(err)}`);
    return { error: errorText(err) };
  }
});

// --- lifecycle -----------------------------------------------------------------

Menu.setApplicationMenu(null);
onVideoChange = onVideoActiveChanged;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) showApp();
  });

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  void app.whenReady().then(() => {
    createMainWindow();
  });
}
