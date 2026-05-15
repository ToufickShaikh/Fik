#!/usr/bin/env bash
# install_tools.sh — Multi-strategy tool installer for Fik.
#
# Strategy per tool (first success wins):
#   1. Already in PATH                     → skip
#   2. apt-get install                     (Debian / Kali / Parrot repos)
#   3. GitHub binary release download      (ProjectDiscovery + ffuf + assetfinder)
#   4. go install                          (if Go is already available)
#
# A missing tool emits a WARNING; it never aborts the scan.
# Individual modules check for their own required tools and skip gracefully.

# Guard against double-source.
if [[ -n "${_FIK_INSTALL_TOOLS_SOURCED:-}" ]]; then
  return 0
fi
_FIK_INSTALL_TOOLS_SOURCED=1

# --- Logging shims (use _lib.sh if loaded, else fall back) ------------------
if ! declare -F log_info >/dev/null 2>&1; then
  log_info()    { echo "[INFO]    $*"; }
  log_warn()    { echo "[WARN]    $*" >&2; }
  log_error()   { echo "[ERROR]   $*" >&2; }
  log_success() { echo "[OK]      $*"; }
  log_step()    { echo; echo "==> $*"; }
fi

# ---------------------------------------------------------------------------
# Tool manifest
# Format: "binary_name|apt_packages (space-sep)|gh_owner|gh_repo|go_pkg"
# Leave gh_owner/gh_repo blank if no releases exist.
# Leave go_pkg blank if not a Go tool.
# ---------------------------------------------------------------------------
_TOOL_SPECS=(
  "subfinder|subfinder|projectdiscovery|subfinder|github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest"
  "httpx|httpx-toolkit|projectdiscovery|httpx|github.com/projectdiscovery/httpx/cmd/httpx@latest"
  "naabu|naabu|projectdiscovery|naabu|github.com/projectdiscovery/naabu/v2/cmd/naabu@latest"
  "nuclei|nuclei|projectdiscovery|nuclei|github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest"
  "katana|katana|projectdiscovery|katana|github.com/projectdiscovery/katana/cmd/katana@latest"
  "ffuf|ffuf|ffuf|ffuf|github.com/ffuf/ffuf/v2@latest"
  "assetfinder|assetfinder|tomnomnom|assetfinder|github.com/tomnomnom/assetfinder@latest"
  "jq|jq|||"
  "unzip|unzip|||"
  "curl|curl|||"
)

# ---------------------------------------------------------------------------
# Internal: run a command with sudo if not root and sudo is available.
# ---------------------------------------------------------------------------
_maybe_sudo() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Strategy 2: apt-get install
# ---------------------------------------------------------------------------
_apt_install() {
  local tool="$1"
  local apt_pkgs="$2"
  command -v apt-get >/dev/null 2>&1 || return 1

  local pkg
  for pkg in ${apt_pkgs}; do
    log_info "[apt] apt-get install -y ${pkg}"
    if _maybe_sudo apt-get install -y --no-install-recommends "${pkg}" >/dev/null 2>&1; then
      hash -r 2>/dev/null || true
      if command -v "${tool}" >/dev/null 2>&1; then
        log_success "[apt] ${tool} installed via package '${pkg}'"
        return 0
      fi
      for _loc in /usr/bin /usr/local/bin /usr/sbin; do
        if [[ -x "${_loc}/${tool}" ]]; then
          export PATH="${_loc}:${PATH}"
          hash -r 2>/dev/null || true
          log_success "[apt] ${tool} installed via package '${pkg}' (found in ${_loc})"
          return 0
        fi
      done
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Strategy 3: Download pre-built binary from GitHub releases
# ---------------------------------------------------------------------------
_install_from_github_release() {
  local tool="$1"
  local owner="$2"
  local repo="$3"
  [[ -z "${owner}" || -z "${repo}" ]] && return 1

  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${arch}" in
    x86_64)        arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    armv7l|armhf)  arch="armv6" ;;
    *)
      log_warn "[gh] Unsupported arch '${arch}' for ${tool} binary download."
      return 1
      ;;
  esac

  local api_url="https://api.github.com/repos/${owner}/${repo}/releases/latest"
  log_info "[gh] Querying ${api_url}"
  local release_json=""
  if command -v curl >/dev/null 2>&1; then
    release_json="$(curl -sfL --max-time 30 "${api_url}" 2>/dev/null || true)"
  elif command -v wget >/dev/null 2>&1; then
    release_json="$(wget -qO- --timeout=30 "${api_url}" 2>/dev/null || true)"
  fi
  if [[ -z "${release_json}" ]]; then
    log_warn "[gh] Could not reach GitHub API for ${tool}."
    return 1
  fi

  local download_url=""
  download_url="$(echo "${release_json}" \
    | grep '"browser_download_url"' \
    | grep -i "${os}_${arch}" \
    | grep -v '\.sha256\|\.md5\|\.txt\|checksums\|sbom' \
    | head -1 \
    | sed 's|.*"browser_download_url": *"\([^"]*\)".*|\1|')"

  if [[ -z "${download_url}" ]]; then
    log_warn "[gh] No ${os}_${arch} asset found for ${tool}."
    return 1
  fi

  log_info "[gh] Downloading ${tool}: ${download_url}"
  local tmpdir
  tmpdir="$(mktemp -d)"
  local tmpfile="${tmpdir}/download"

  local dl_ok=false
  if command -v curl >/dev/null 2>&1; then
    curl -sfL --max-time 120 "${download_url}" -o "${tmpfile}" 2>/dev/null && dl_ok=true
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=120 "${download_url}" -O "${tmpfile}" && dl_ok=true
  fi
  if [[ "${dl_ok}" == false ]]; then
    log_warn "[gh] Download failed for ${tool}."
    rm -rf "${tmpdir}"; return 1
  fi

  local install_dir="/usr/local/bin"
  local use_sudo=false
  if [[ ! -w "${install_dir}" ]]; then
    if command -v sudo >/dev/null 2>&1; then
      use_sudo=true
    else
      install_dir="${HOME}/.local/bin"
      mkdir -p "${install_dir}"
      export PATH="${install_dir}:${PATH}"
    fi
  fi

  local extract_dir="${tmpdir}/extract"
  mkdir -p "${extract_dir}"
  if [[ "${download_url}" == *.zip ]]; then
    if ! command -v unzip >/dev/null 2>&1; then
      _maybe_sudo apt-get install -y unzip >/dev/null 2>&1 || true
    fi
    unzip -q "${tmpfile}" -d "${extract_dir}" 2>/dev/null || { rm -rf "${tmpdir}"; return 1; }
  else
    tar -xzf "${tmpfile}" -C "${extract_dir}" 2>/dev/null || { rm -rf "${tmpdir}"; return 1; }
  fi

  local binary=""
  binary="$(find "${extract_dir}" -maxdepth 4 -type f -name "${tool}" 2>/dev/null | head -1)"
  if [[ -z "${binary}" || ! -f "${binary}" ]]; then
    log_warn "[gh] Binary '${tool}' not found inside downloaded archive."
    rm -rf "${tmpdir}"; return 1
  fi

  chmod +x "${binary}"
  if [[ "${use_sudo}" == true ]]; then
    sudo cp "${binary}" "${install_dir}/${tool}"
    sudo chmod +x "${install_dir}/${tool}"
  else
    cp "${binary}" "${install_dir}/${tool}"
    chmod +x "${install_dir}/${tool}"
  fi

  rm -rf "${tmpdir}"
  hash -r 2>/dev/null || true

  if command -v "${tool}" >/dev/null 2>&1; then
    log_success "[gh] ${tool} installed from GitHub release."
    return 0
  fi
  log_warn "[gh] Binary placed but ${tool} still not in PATH."
  return 1
}

# ---------------------------------------------------------------------------
# Strategy 4: go install  (only if go is already on the system)
# ---------------------------------------------------------------------------
_go_install() {
  local tool="$1"
  local go_pkg="$2"
  [[ -z "${go_pkg}" ]] && return 1

  if ! command -v go >/dev/null 2>&1; then
    log_warn "[go] Go is not installed; cannot install ${tool} via go install."
    return 1
  fi

  log_info "[go] go install ${go_pkg}"
  go install -v "${go_pkg}" 2>&1 | tail -3 || { log_warn "[go] go install failed for ${tool}."; return 1; }

  local gobin=""
  gobin="$(go env GOBIN 2>/dev/null || true)"
  if [[ -z "${gobin}" ]]; then
    local gopath=""
    gopath="$(go env GOPATH 2>/dev/null || true)"
    gobin="${gopath:-${HOME}/go}/bin"
  fi
  export PATH="${gobin}:${PATH}"

  if [[ -x "${gobin}/${tool}" ]]; then
    local dst="/usr/local/bin/${tool}"
    if [[ ! -e "${dst}" ]]; then
      _maybe_sudo ln -sf "${gobin}/${tool}" "${dst}" 2>/dev/null || true
    fi
  fi

  hash -r 2>/dev/null || true
  command -v "${tool}" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Public: ensure_required_tools
# Always returns 0 — modules guard their own missing-tool requirements.
# ---------------------------------------------------------------------------
ensure_required_tools() {
  log_step "Tool dependency check (apt → GitHub release → go install)"
  local missing_tools=()

  if command -v apt-get >/dev/null 2>&1; then
    log_info "Refreshing apt cache..."
    _maybe_sudo apt-get update -qq 2>/dev/null || true
  fi

  local spec tool apt_pkgs gh_owner gh_repo go_pkg
  for spec in "${_TOOL_SPECS[@]}"; do
    IFS='|' read -r tool apt_pkgs gh_owner gh_repo go_pkg <<< "${spec}"

    if command -v "${tool}" >/dev/null 2>&1; then
      log_success "${tool} — already in PATH."
      continue
    fi

    log_info "Installing missing tool: ${tool}"
    local installed=false

    if [[ -n "${apt_pkgs}" ]] && _apt_install "${tool}" "${apt_pkgs}"; then
      installed=true
    fi

    if [[ "${installed}" == false && -n "${gh_owner}" ]]; then
      if _install_from_github_release "${tool}" "${gh_owner}" "${gh_repo}"; then
        installed=true
      fi
    fi

    if [[ "${installed}" == false && -n "${go_pkg}" ]]; then
      if _go_install "${tool}" "${go_pkg}"; then
        installed=true
      fi
    fi

    if [[ "${installed}" == false ]]; then
      log_warn "Could not install '${tool}'. Modules needing it will skip gracefully."
      missing_tools+=("${tool}")
    fi
  done

  if (( ${#missing_tools[@]} > 0 )); then
    log_warn "Tools unavailable after all install attempts: ${missing_tools[*]}"
    log_warn "Scan will run with reduced functionality."
  else
    log_success "All tools are available."
  fi

  return 0
}