# Note Panel for Obsidian

A macOS floating panel for Obsidian's real Markdown editor and Live Preview. Keep several notes in native tabs, search notes from the small icon at the right, and show or hide the panel with a global shortcut.

- Native tabs support multiple notes in the same panel.
- The compact note-picker icon replaces the two large toolbar buttons.
- Escape keeps Obsidian's normal editor, picker, and menu behavior. Use the global shortcut to hide the panel and save its open editors.
- Closing Obsidian's main window keeps it hidden in the running app, so the panel can still open. **Quit Obsidian** exits the app and its plugin.
- The panel remembers its notes, selected tab, and window bounds. Panel windows are excluded from Obsidian's saved workspace layout.

This plugin is macOS only (macOS 13 or newer). Its integration targets Obsidian **1.13.7 / Electron 43** and uses private Obsidian and Electron APIs. An Obsidian upgrade can require changes. The native module contains both Apple Silicon (`arm64`) and Intel (`x86_64`) code; Intel runtime behavior still needs separate verification.

## Install a release

Download the installation ZIP from [Releases](https://github.com/nextster/obsidian-note-panel/releases), extract it, and place the `panel-micro-demo` directory in your vault's `.obsidian/plugins/` directory. Enable **Note Panel** in Obsidian's Community plugins settings.

The internal plugin ID stays `panel-micro-demo` to preserve settings from the earlier local prototype. When updating an existing installation, replace the runtime files and keep its `data.json`.

Restart Obsidian after updating the native bridge or main-process helpers. JavaScript-only editor changes can use a plugin reload.

The plugin is distributed as a complete ZIP because it also needs CommonJS helpers and a native `.node` module. Copying just `main.js` and `manifest.json` is insufficient.

## Global Ctrl+Q

Obsidian's **Note Panel: Toggle note panel** command works inside the app. A global shortcut uses the loopback control endpoint while Obsidian is running:

```sh
/usr/bin/curl --silent --show-error --max-time 3 http://127.0.0.1:51235/toggle >/dev/null
```

Map Control+Q to that command using Karabiner-Elements. An existing rule calling the same endpoint continues to work; the plugin does not change keyboard settings or install a background service. The shortcut works when the main window has been closed but the app is still running. It does not start a fully quit app.

## Develop

Requirements: macOS, Xcode Command Line Tools, and Node.js 22 or newer. JavaScript tests have no package dependencies and can run on other operating systems.

```sh
npm test
npm run build:native
npm run install:plugin -- "/path/to/your/vault"
```

The native build uses installed Node headers when available, or downloads pinned official Node **26.10.0** headers and verifies their SHA256 checksum. To select your own installed headers, set `NODE_INCLUDE_DIR` to the directory containing `node_api.h`; `NODE_HEADERS_VERSION` selects the fallback download version. The addon uses Node-API version 8 rather than V8 interfaces.

All native build products, downloaded headers, and installation archives live outside the repository in `~/Library/Developer/Xcode/DerivedData/ObsidianNotePanel/`.

To update JavaScript while keeping an existing native bridge:

```sh
npm run install:plugin -- "/path/to/your/vault" --skip-native
```

To install a previously built bridge:

```sh
npm run install:plugin -- "/path/to/your/vault" --native "/path/to/panel_bridge.node"
```

The installer copies only runtime files, preserves settings, and does not enable the plugin or reload Obsidian. For CLI debugging, first run `obsidian version` and `obsidian help`; consult `obsidian help <command>` for the installed command's syntax. The development target's verified Obsidian version is 1.13.7. See the [official Obsidian CLI documentation](https://obsidian.md/help/cli).

## Architecture and local control

`main.js` opens Obsidian popout workspace leaves and uses the normal Markdown view save lifecycle. `popup-main.cjs` temporarily wraps the popup handler to create an Electron panel while preserving Obsidian's web preferences. `panel_bridge.mm` is a small AppKit Node-API addon loaded in Electron's main process, which keeps the panel available across macOS Spaces and fullscreen applications.

The local HTTP server binds to `127.0.0.1:51235`. It supports `/toggle`, `/hide`, `/status`, and POST `/open` with `{"path":"existing-note.md"}`. It does not expose note text or execute request-supplied code. Local control is intended for trusted software on the same computer; no remote service is involved.

References: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window), [Electron app lifecycle](https://www.electronjs.org/docs/latest/api/app), and [Node-API](https://nodejs.org/api/n-api.html).

## Verified behavior

Verified on 2026-10-05 with Obsidian 1.13.7, Electron 43.3.0, and Apple Silicon macOS:

- Edited two notes in separate tabs and checked their saved Markdown files.
- Opened the panel and its note picker with the main window closed.
- Sent native Cmd+T and Cmd+W input to verify tab behavior. Escape keeps the panel open and dismisses its note picker.
- Checked rapid toggles, native panel closure, plugin reload, and tab restoration after an app restart.
- Confirmed a normal quit exits the process with the panel present.

## Build an installation archive

```sh
npm test
npm run package
```

The result is `~/Library/Developer/Xcode/DerivedData/ObsidianNotePanel/releases/note-panel-0.2.1.zip`. CI runs JavaScript regression tests, builds a universal native bridge on macOS, checks its architectures and export, and uploads an installation archive. Runtime checks in Obsidian are separate from these automated checks.

To publish a release, update `manifest.json`, `package.json`, and `versions.json`, then push a tag equal to the manifest version, such as `0.2.1`. The release workflow builds and publishes the ZIP after tests pass.
