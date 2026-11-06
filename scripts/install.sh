#!/usr/bin/env bash
# Install the latest WUR release for the current macOS or Linux architecture.
set -euo pipefail

REPOSITORY='Gr3gorywolf/Wine-Unified-Runner'
INSTALL_DIR="${HOME}/wur"
RELEASE_BASE="https://github.com/${REPOSITORY}/releases/latest/download"

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "${1} is required to install WUR."
}

path_contains() {
  [[ ":${PATH}:" == *":$1:"* ]]
}

ask_yes_no() {
  local prompt="$1"
  local answer
  [[ -r /dev/tty ]] || return 1
  printf '%s [y/N] ' "$prompt" >/dev/tty
  IFS= read -r answer </dev/tty || return 1
  [[ "$answer" =~ ^([Yy]|[Yy][Ee][Ss])$ ]]
}

create_link() {
  local directory="$1"
  local link="${directory}/wur"

  if [[ -e "$link" && ! -L "$link" ]]; then
    printf 'Cannot replace existing non-symlink: %s\n' "$link" >&2
    return 1
  fi
  ln -sfn "${INSTALL_DIR}/wur" "$link"
  printf 'Created global command: %s\n' "$link"
}

add_global_command() {
  local directory
  local candidates=("${HOME}/.local/bin" "${HOME}/bin" '/opt/homebrew/bin' '/usr/local/bin')

  # Prefer a directory that is already in PATH and writable by this user.
  for directory in "${candidates[@]}"; do
    path_contains "$directory" || continue
    if [[ ! -d "$directory" && "$directory" == "${HOME}/"* ]]; then
      mkdir -p "$directory"
    fi
    if [[ -d "$directory" && -w "$directory" ]]; then
      create_link "$directory"
      return $?
    fi
  done

  # A standard system directory may be in PATH but need administrator access.
  for directory in '/opt/homebrew/bin' '/usr/local/bin'; do
    path_contains "$directory" || continue
    [[ -d "$directory" ]] || continue
    if ask_yes_no "${directory} is in PATH but needs administrator access. Create the link there?"; then
      local link="${directory}/wur"
      if [[ -e "$link" && ! -L "$link" ]]; then
        printf 'Cannot replace existing non-symlink: %s\n' "$link" >&2
        return 1
      fi
      sudo ln -sfn "${INSTALL_DIR}/wur" "$link"
      printf 'Created global command: %s\n' "$link"
      return 0
    fi
  done

  printf 'No writable directory from PATH was found. WUR is available at %s/wur.\n' "$INSTALL_DIR"
  printf 'Your shell configuration was not changed.\n'
}

require_command curl
require_command unzip
require_command mktemp

case "$(uname -s)" in
  Darwin)
    archive_name='wur-macos-universal.zip'
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64 | amd64) archive_name='wur-linux-x86_64.zip' ;;
      aarch64 | arm64) archive_name='wur-linux-arm64.zip' ;;
      *) fail "Unsupported Linux architecture: $(uname -m)" ;;
    esac
    ;;
  *)
    fail "WUR supports macOS and Linux; detected $(uname -s)."
    ;;
esac

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/wur-install.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT
archive="${temporary_dir}/${archive_name}"
extracted="${temporary_dir}/extracted"

printf 'Downloading %s…\n' "$archive_name"
curl --fail --location --retry 3 --retry-delay 1 --output "$archive" "${RELEASE_BASE}/${archive_name}"
mkdir -p "$extracted"
unzip -q "$archive" -d "$extracted"

for file in wur defaults.json wur-overrides.template.jsonc; do
  [[ -f "${extracted}/${file}" ]] || fail "Release archive is missing ${file}."
done

# Update only WUR's program files; existing portable state stays intact.
mkdir -p "$INSTALL_DIR"
install -m 755 "${extracted}/wur" "${INSTALL_DIR}/wur"
install -m 644 "${extracted}/defaults.json" "${INSTALL_DIR}/defaults.json"
install -m 644 "${extracted}/wur-overrides.template.jsonc" "${INSTALL_DIR}/wur-overrides.template.jsonc"

printf 'WUR installed in %s\n' "$INSTALL_DIR"
if ask_yes_no 'Add the wur command to a directory already in PATH?'; then
  add_global_command
else
  printf 'Run WUR with: %s/wur --help\n' "$INSTALL_DIR"
fi
