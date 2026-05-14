#!/usr/bin/env bash
set -euo pipefail

# Mapping of CLI binary name -> `go install` source path (latest).
# Kept as parallel arrays for bash 3 compatibility (macOS default).
TOOL_NAMES=(
  "subfinder"
  "httpx"
  "naabu"
  "nuclei"
  "katana"
  "ffuf"
)

TOOL_INSTALL_CMDS=(
  "go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
  "go install -v github.com/projectdiscovery/httpx/cmd/httpx@latest"
  "go install -v github.com/projectdiscovery/naabu/v2/cmd/naabu@latest"
  "go install -v github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
  "go install -v github.com/projectdiscovery/katana/cmd/katana@latest"
  "go install -v github.com/ffuf/ffuf/v2@latest"
)

_resolve_gobin() {
  local gobin
  gobin="$(go env GOBIN 2>/dev/null || true)"
  if [[ -z "${gobin}" ]]; then
    local gopath
    gopath="$(go env GOPATH 2>/dev/null || true)"
    if [[ -n "${gopath}" ]]; then
      gobin="${gopath}/bin"
    else
      gobin="${HOME}/go/bin"
    fi
  fi
  echo "${gobin}"
}

_symlink_to_usr_local_bin() {
  local tool="$1"
  local gobin="$2"
  local src="${gobin}/${tool}"
  local dst="/usr/local/bin/${tool}"

  if [[ ! -x "${src}" ]]; then
    return 1
  fi

  if [[ -L "${dst}" || -e "${dst}" ]]; then
    # Already present (symlink, real binary, or existing link). Leave it alone.
    return 0
  fi

  if [[ -w "/usr/local/bin" ]]; then
    ln -s "${src}" "${dst}"
  elif command -v sudo >/dev/null 2>&1; then
    sudo ln -s "${src}" "${dst}"
  else
    echo "[INSTALL][WARN] Cannot symlink ${src} -> ${dst} (no write permission and sudo unavailable)."
    return 1
  fi
}

_install_one_tool() {
  local tool="$1"
  local install_cmd="$2"

  echo "[INSTALL] Installing missing tool: ${tool}"
  echo "[INSTALL] Running: ${install_cmd}"

  if ! eval "${install_cmd}"; then
    echo "[INSTALL][ERROR] go install failed for ${tool}."
    return 1
  fi

  local gobin
  gobin="$(_resolve_gobin)"
  export PATH="${gobin}:${PATH}"

  _symlink_to_usr_local_bin "${tool}" "${gobin}" || true
  return 0
}

ensure_required_tools() {
  if ! command -v go >/dev/null 2>&1; then
    echo "[INSTALL][ERROR] 'go' is not installed. Install Go (https://go.dev/dl/) before running this framework."
    return 1
  fi

  local missing_after=()
  local i tool install_cmd

  for i in "${!TOOL_NAMES[@]}"; do
    tool="${TOOL_NAMES[$i]}"
    install_cmd="${TOOL_INSTALL_CMDS[$i]}"

    if command -v "${tool}" >/dev/null 2>&1; then
      continue
    fi

    if ! _install_one_tool "${tool}" "${install_cmd}"; then
      echo "[INSTALL][ERROR] Failed to install ${tool}. Please install it manually: ${install_cmd}"
      missing_after+=("${tool}")
      continue
    fi

    # Re-check PATH after install + symlink attempt.
    hash -r 2>/dev/null || true
    if ! command -v "${tool}" >/dev/null 2>&1; then
      echo "[INSTALL][ERROR] Failed to install ${tool}. Please install it manually: ${install_cmd}"
      missing_after+=("${tool}")
    else
      echo "[INSTALL] ${tool} is now available."
    fi
  done

  if (( ${#missing_after[@]} > 0 )); then
    echo "[INSTALL][ERROR] The following tools are still missing: ${missing_after[*]}"
    return 1
  fi

  echo "[INSTALL] All required tools are present."
  return 0
}
