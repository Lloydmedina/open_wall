# Open Wall

A free, open-source desktop wallpaper app for Windows — static images and
looping live-video wallpapers, no account and no paywall.

## Features

- **Wallpaper catalog** — browse a curated library of images and videos
- **Live video wallpapers** — MP4/WebM playback behind your desktop icons
  (multi-monitor: one window per display)
- **Local library scan** — scans your local wallpaper folders for video
  items and plays them directly; other items can be applied as static
  images via their previews. Open the **Local library** button in the
  bottom-right corner. **Add folder** / **Add files** lets you point it at
  your own folders or media files on top of the default scan.
- **Custom app icon** — Settings panel lets you swap the window/taskbar/tray
  icon and stamp it onto a desktop shortcut, like Windows' own "Change Icon"
- **Tray control** — while a video wallpaper is running, a tray icon offers
  "Show app", "Stop video wallpaper" and "Quit"

## Run

```bat
run.bat
```

or

```bat
npm install
npm start
```

> If you have `ELECTRON_RUN_AS_NODE` set in your environment, `run.bat`
> clears it for you — the plain `npm start` won't.

## Build (portable exe)

```bat
npm run dist
or just find the .exe file in the dist folder
```

Outputs `dist\OpenWall.exe` (single portable executable, no install needed).

## How it works

- **Electron** shell with a frameless window; all system effects are done in
  the main process via small PowerShell snippets — no native addons.
- Static wallpapers use `SystemParametersInfo(SPI_SETDESKWALLPAPER)`.
- Video wallpapers render in a borderless `BrowserWindow` reparented under
  the desktop layer (`Progman`/`WorkerW`), looping muted via `<video>`.
- The UI is a prebuilt bundle in `app/renderer/assets/`; the Local library
  and Settings pages are standalone pages alongside it.

## Notes

- The online catalog streams thumbnails and media from
  `cdn.livelywallpaper.app` — internet access is needed for browsing, but
  imported local wallpapers work fully offline.
- Interactive "scene" wallpapers use a proprietary `.pkg` format that this
  app cannot render; apply them as static images via their previews.

## License

MIT — see [LICENSE](LICENSE).
