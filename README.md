# Note Panel for Obsidian

A macOS floating panel for Obsidian's real Markdown editor and Live Preview. Keep several notes in native tabs, search notes from the small icon at the right, and show or hide the panel with a global shortcut.

- Native tabs support multiple notes in the same panel.
- The compact note-picker icon replaces the two large toolbar buttons.
- **Cmd+Shift+B** shows or hides a folder tree in the panel. Click a note to open it in the current tab. The panel remembers sidebar visibility and expanded folders; **Cmd+B** keeps its normal bold formatting behavior.
- The sidebar icon next to the window controls also opens or closes the folder tree.
- While the panel is focused, hold **Shift** and move the mouse to move the panel, without clicking. Its size stays fixed. The pointer can be anywhere on screen.
- While the panel is focused, hold **Shift+Option** and move the mouse to resize it, without clicking. The pointer can be anywhere on screen. The corner nearest to the pointer when the shortcut is pressed follows the mouse; the opposite corner stays fixed.
- Press or release Option while holding Shift to switch between moving and resizing without a jump. Release Shift or switch focus to stop both modes. Option alone does not move the panel.
- Opening a note into the hidden panel through Obsidian reveals the panel, including reopening the same note.
- Escape keeps Obsidian's normal editor, picker, and menu behavior. Use the global shortcut to hide the panel and save its open editors.
- Closing Obsidian's main window keeps it hidden in the running app, so the panel can still open. **Quit Obsidian** exits the app and its plugin.
- The panel remembers its notes, selected tab, and window bounds. Panel windows are excluded from Obsidian's saved workspace layout.

This plugin is macOS only (macOS 13 or newer). Its integration targets Obsidian **1.13.7 / Electron 43** and uses private Obsidian and Electron APIs. An Obsidian upgrade can require changes. The native module contains both Apple Silicon (`arm64`) and Intel (`x86_64`) code; Intel runtime behavior still needs separate verification.

## Install with Homebrew

```sh
brew install --cask nextster/tap/obsidian-note-panel
```

On the first installation, Homebrew automatically installs the plugin if Obsidian knows exactly one available vault. Automatic detection supports vaults with the default `.obsidian` configuration folder.

If there are several vaults, or none can be detected, Homebrew asks you to finish setup with:

```sh
note-panel install
```

This command opens a folder chooser. You can also pass a vault path directly: `note-panel install "/path/to/your/vault"`. Enable **Note Panel** in Obsidian's Community plugins settings and restart Obsidian. Homebrew installation never opens a dialog or starts Obsidian.

Upgrade the plugin in registered vaults with:

```sh
brew upgrade --cask nextster/tap/obsidian-note-panel
```

Restart Obsidian after an update. Homebrew remembers the vaults you selected and updates only its registered installations. If you removed the last registered vault or have not chosen one yet, updates do not select a different vault automatically; use `note-panel install` to make a new choice.

To remove the plugin from one vault and stop managing it with Homebrew:

```sh
note-panel uninstall "/path/to/your/vault"
```

To remove the Homebrew command and the plugin from all registered vaults:

```sh
brew uninstall --cask nextster/tap/obsidian-note-panel
```

Uninstall preserves notes, `data.json`, and unrelated files. Restart Obsidian after removing the plugin. Homebrew also keeps the selected vaults and ownership receipts, so reinstalling the cask restores those installations; removing a single vault with `note-panel uninstall` forgets that vault. The installer uses macOS's system Ruby and adds no Node.js dependency or background service.

## Install a release manually

Download the installation ZIP from [Releases](https://github.com/nextster/obsidian-note-overlay/releases), extract it, and place the `panel-micro-demo` directory in your vault's `.obsidian/plugins/` directory. Enable **Note Panel** in Obsidian's Community plugins settings.

The internal plugin ID stays `panel-micro-demo` to preserve settings from the earlier local prototype. When updating an existing installation, replace the runtime files and keep its `data.json`.

Restart Obsidian after updating the native bridge or CommonJS helpers. Changes limited to `main.js` can use a plugin reload.

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

`main.js` opens Obsidian popout workspace leaves and uses the normal Markdown view save lifecycle. `popup-main.cjs` temporarily wraps the popup handler to create an Electron panel while preserving Obsidian's web preferences. `panel_bridge.m` is a small AppKit Node-API addon loaded in Electron's main process, which keeps the panel available across macOS Spaces and fullscreen applications. `panel-resize.cjs` samples Electron's global cursor position only while a move or resize shortcut is held and the panel is focused.

The local HTTP server binds to `127.0.0.1:51235`. It supports `/toggle`, `/hide`, `/status`, and POST `/open` with `{"path":"existing-note.md"}`. It does not expose note text or execute request-supplied code. Local control is intended for trusted software on the same computer; no remote service is involved.

References: [Electron BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window), [Electron screen](https://www.electronjs.org/docs/latest/api/screen#screengetcursorscreenpoint), [Electron app lifecycle](https://www.electronjs.org/docs/latest/api/app), and [Node-API](https://nodejs.org/api/n-api.html).

## Verified behavior

Verified on 2026-10-05 with Obsidian 1.13.7, Electron 43.3.0, and Apple Silicon macOS:

- Edited two notes in separate tabs and checked their saved Markdown files.
- Opened the panel and its note picker with the main window closed.
- Sent native Cmd+T and Cmd+W input to verify tab behavior. Escape keeps the panel open and dismisses its note picker.
- Checked rapid toggles, native panel closure, plugin reload, and tab restoration after an app restart.
- Confirmed a normal quit exits the process with the panel present.
- Resized without clicks using native Shift+Option key input and real system cursor movement outside the panel. Checked all four nearest corners, their fixed opposite corners, native minimum dimensions, and selection staying fixed after crossing the window center. Reversing after reaching minimum size keeps the original anchor. Key release, focus loss, and hiding cancel resizing; returning focus does not resume a stale gesture.
- Moved the panel with native Shift key input and real system cursor movement outside the panel, preserving its size. Checked modifier release and that Option alone does not move the panel. Automated checks cover both modifier press orders, move/resize switching without a jump, and focus/hide cancellation.
- Opened notes through the official Obsidian CLI into a hidden panel and verified it appears for both a different note and the same note. Checked main-window and background opens stay isolated, and an older delayed open cannot undo a newer hide.

## Build an installation archive

```sh
npm test
npm run package
```

The result is `~/Library/Developer/Xcode/DerivedData/ObsidianNotePanel/releases/note-panel-0.5.5.zip`. It contains the runtime `panel-micro-demo` directory and the `note-panel` vault installer. CI runs regression tests, builds a universal native bridge on macOS, checks its architectures and export, and uploads an installation archive. Runtime checks in Obsidian are separate from these automated checks.

To publish a release, update `manifest.json`, `package.json`, and `versions.json`, then push a tag equal to the manifest version, such as `0.5.5`. The release workflow builds and publishes the ZIP after tests pass. Update `nextster/homebrew-tap` with the published archive's SHA256 checksum.
