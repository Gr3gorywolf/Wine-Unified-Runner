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

## Manage runtimes

```sh
# Releases compatible with the current platform.
wur runtime list

# Complete catalog, including the other platform.
wur runtime list --all

# Install the recommended runtime for this platform.
wur runtime install

# Install or remove a specific runtime.
wur runtime install ge-proton latest
wur runtime remove game-porting-toolkit latest

# Inspect managed installations.
wur runtime installed
```

There is no separate Proton command: Proton is one runtime kind among the sources managed by `wur runtime`.

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

On macOS, the generic `dxvk` component resolves to `dxvk-macos`; on Linux it resolves to normal DXVK. DXMT is available for supported Wine Staging configurations. Proton includes its own graphics stack, so WUR does not overwrite it.

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
