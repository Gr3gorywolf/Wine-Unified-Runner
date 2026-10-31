# WUR

**WUR — Wine Unified Runner** is a portable command-line tool for creating Wine environments and launching Windows games on macOS and Linux. It manages runtimes, components, Wine prefixes, and shared user data in one self-contained directory.

WUR follows the runtime providers, asset selection, prefix setup, and launch settings used by Heroic Games Launcher 2.22.4, without requiring Electron or a graphical interface.

## Platform support

| Platform | Runnable layers |
| --- | --- |
| Linux | GE-Proton, Valve Proton, Proton-CachyOS, Wine-Lutris |
| macOS | Wine Staging, Wine-CrossOver, Game Porting Toolkit (GPTK) |

Runtime management is unified under `wur runtime`. Its default catalog contains Proton and Wine builds on Linux, and the applicable Wine or GPTK alternatives on macOS. Use `--all` to inspect the complete cross-platform catalog.

## Install from source

```sh
npm install
npm run build
npm link
wur --help
```

Before linking, run the compiled CLI directly:

```sh
node dist/src/cli.js --help
```

## Build a standalone binary

The standalone binary embeds Node.js, so the destination computer does not need Node installed.

```sh
npm install
npm run build-binary
./release/wur --help
```

`build-binary` produces `release/wur` for the current platform. On macOS it creates an ad-hoc-signed universal arm64/x86_64 binary; on Linux it creates a binary for the current architecture. `release/defaults.json` is copied next to it.

Normal binary builds replace only `release/wur` and preserve the portable state around it: `user/`, runtimes, components, containers, and configuration. To recreate the entire release directory from scratch:

```sh
npm run build-binary -- --clean
```

Build-time Node archives are downloaded from the official distribution, verified against `SHASUMS256.txt`, and cached under `.cache/node-binaries/`. Override the pinned build runtime only when needed with `WUR_NODE_VERSION`.

## Quick start

```sh
# See the compatible runtime and component recommendations for this system.
wur suggest

# Install exactly what config/defaults.json enables for this platform.
wur install-recommended

# The first run creates and prepares the default container automatically.
wur run "/games/My Game/Game.exe" -- -windowed
```

The runtime defined by a container is installed automatically on first use when it is missing. If installation cannot complete, WUR stops before starting the game and reports the error.

Each game launch runs in its own process group. When WUR exits normally or receives `Ctrl+C`, terminal-close (`SIGHUP`), `SIGTERM`, or `SIGQUIT`, it terminates that group and requests `wineserver` shutdown so Wine helpers and game descendants do not remain running.

## Launch games

```sh
# Use the default container.
wur run /games/Celeste/Celeste.exe

# Select one container for this launch only.
wur run /games/Cyberpunk/bin/Cyberpunk2077.exe --container cyberpunk -- -skipStartScreen

# Use a different host working directory.
wur run /games/setup.exe --container installers --cwd /games -- /silent
```

`run` is optional when the first argument is an existing Windows-launchable file:

```sh
wur /games/Celeste/Celeste.exe --container celeste
```

The shortcut accepts the standard Windows `PATHEXT` file types (`.com`, `.exe`, `.bat`, `.cmd`, `.vbs`, `.vbe`, `.js`, `.jse`, `.wsf`, `.wsh`, `.msc`) and Shell executable types (`.pif`, `.scf`, `.scr`). Pass program arguments after `--`.

### Per-game overrides

On the first launch, WUR writes `wur-overrides.ini` beside the Windows executable from the bundled `wur-overrides.template.ini`. The generated INI is fully commented and documents the available container selection, runtime, component, launch, and environment overrides. Delete the sidecar to recreate it from the current template.

```ini
[container]
name = celeste

[components]
dxvk.version = 2.4

[launch]
showFps = true

[environment]
DXVK_ASYNC = 1
```

The precedence is intentional: `wur run GAME.exe --container another-container` ignores only `[container] name`; the runtime, component, launch, and environment entries still apply. Without `--container`, `[container] name` selects the container. Overrides are in-memory for that launch and never rewrite `container.json`.

## Manage runtimes

```sh
# Managed runtime installations, then compatible remote releases.
wur runtime list
wur runtime list --remote

# Complete catalog, including the other platform.
wur runtime list --remote --all

# Install the recommended runtime for this platform.
wur runtime install

# Install or remove a specific runtime.
wur runtime install ge-proton latest
wur runtime remove game-porting-toolkit latest

```

There is no separate Proton command: Proton is one runtime kind among the sources managed by `wur runtime`.
Each listed runtime also exposes `ignoredComponents`: components WUR will not inject or override for that runtime. For example, Wine-CrossOver owns its graphics stack, so its DXVK override is ignored.

## Manage components

```sh
# Installed components, then available compatible releases.
wur component list
wur component list --remote
wur component list --remote --all

# Install or remove a component.
wur component install dxvk
wur component install dxmt
wur component remove dxvk-macos latest
```

On macOS, the generic `dxvk` component resolves to `dxvk-macos`; on Linux it resolves to normal DXVK. DXMT remains available for manual experimentation, but it is not applied automatically to containers. Runtime-specific exclusions are declared by each runtime's `ignoredComponents` metadata.

## Containers and prefixes

A container is a reproducible Wine prefix plus `container.json` under `containers/<name>/`.

```sh
# Create and initialize a prefix.
wur container create --name cyberpunk --runtime ge-proton/latest \
  --component dxvk-nvapi=true \
  --set launch.enableWayland=true

# Inspect and choose a default container.
wur container list
wur container show --name cyberpunk
wur container default --name cyberpunk

# Change settings or remove a whole prefix.
wur container configure --name cyberpunk --set launch.enableHdr=true
wur container remove --name cyberpunk
```

The runtime declaration is portable: it stores only `source` and `version`, never a path to a local runtime installation. WUR finds or installs that runtime when the container is built or launched.

### Run tools inside a container

`container exec` starts a Windows executable or Wine built-in with the selected prefix, runtime, components, and launch environment. It is useful for inspecting or repairing a prefix without launching a game.

```sh
# Common built-in tools.
wur container exec explorer.exe --name cyberpunk
wur container exec cmd.exe --name cyberpunk
wur container exec taskmgr.exe --name cyberpunk
wur container exec regedit.exe --name cyberpunk
wur container exec winecfg --name cyberpunk

# Produce Wine's DirectX diagnostic report in the current directory.
wur container exec dxdiag.exe --name cyberpunk -- /t dxdiag.txt

# Run an OpenGL or Vulkan diagnostic that is installed in the prefix.
wur container exec glview.exe --name cyberpunk
wur container exec vkcube.exe --name cyberpunk
```

Wine provides `dxdiag.exe` for DirectX diagnostics. OpenGL and Vulkan test programs are not bundled by Wine, so install or provide a compatible Windows diagnostic such as `glview.exe`, `vkcube.exe`, or `vulkaninfo.exe`, then pass it to `container exec`.

### Build containers from a manifest

Create `containers/<name>/config.json` with only the settings that differ from the defaults:

```json
{
  "runtime": { "source": "game-porting-toolkit" },
  "components": {
    "dxvk": { "enabled": true }
  },
  "launch": {
    "enableMsync": true,
    "environment": { "WINEDEBUG": "-all" }
  }
}
```

Then build one or every manifest:

```sh
wur build --name my-game
wur build
```

WUR completes the missing fields from `config/defaults.json`, writes `container.json`, installs the requested runtime and components, and prepares the prefix.

## Defaults and recommendations

`config/defaults.json` is the editable platform-aware template used for new containers. `install-recommended` uses that same file, so the enabled component set and runtime are always explicit.

```sh
wur defaults show
wur defaults set --set runtime.source='"ge-proton"'
wur install-recommended --dry-run
wur install-recommended
```

## Portable data and shared Windows user

By default, WUR keeps all state beside the Node distribution (`dist/`) or standalone binary (`release/`):

```text
release/
  wur
  defaults.json
  user/
    AppData/
    Documents/
    Saved Games/
  config/
    config.json
    defaults.json
  runtimes/
  components/
  containers/
    game-name/
      container.json
      prefix/
```

Every prefix exposes the same Windows user, `C:\\users\\user`, through a link to the portable `user/` directory. Saves, Documents, AppData, and similar Windows profile data are therefore shared across containers and runtimes.

To place state elsewhere for one command, use `--home DIRECTORY`. To make another directory the default, set `WUR_HOME`. The former `PROTON_CLI_HOME` variable remains a compatibility alias for older installations.

## Output and global options

Commands that return lists or structured values support `--json`. Use `--home DIRECTORY` before the program separator, and use `--` to pass remaining arguments to the Windows executable.

`runtime install --json` and `component install --json` use JSON Lines so callers can consume live download state. Each line is either a progress event or, if the installation fails, an error event:

```json
{"name":"wine-crossover","progress":50}
{"name":"wine-crossover","progress":100}
{"error":"Download failed (404) for https://example.invalid/runtime.tar.xz"}
```

```sh
wur runtime list --json
wur --home /Volumes/Games/wur container list
wur run game.exe -- --safe-mode
```

Run `wur --help` for the color-coded command reference grouped by launch, runtimes, components, containers, and configuration. Colors are disabled automatically when output is redirected, or when `NO_COLOR` is set.

## Download integrity

Release information comes from the GitHub APIs used by Heroic. GE-Proton and Proton-CachyOS downloads verify SHA-512 when the release provides a checksum. Every download extracts into a temporary directory and moves into the managed location only after successful completion.

## License and attribution

WUR is GPL-3.0-only. It is based on the behavior and providers of [Heroic Games Launcher](https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher), reference version 2.22.4. Runtimes and components remain subject to their respective licenses.

WUR is an independent project and is not affiliated with WineHQ, Heroic Games Launcher, or any runtime provider.
