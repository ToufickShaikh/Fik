# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# Fik backend image — Node.js API + every recon binary baked in.
#
# Why Debian (not Alpine)?
#   - The recon stack needs glibc-compiled binaries from ProjectDiscovery,
#     plus apt packages (jq, curl, git, unzip, golang, dnsutils, ...).
#   - Alpine's musl breaks subfinder/nuclei/katana releases in subtle ways.
#
# Tools are downloaded AT BUILD TIME on the host that has internet, so the
# runtime container needs no network access to api.github.com.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim

ARG TARGETARCH=amd64
ENV DEBIAN_FRONTEND=noninteractive

# ---- 1. Base OS dependencies -------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl wget jq unzip git \
      dnsutils whois \
      python3 python3-pip \
      chromium chromium-sandbox fonts-liberation \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
      libxcomposite1 libxrandr2 libgbm1 libpango-1.0-0 libasound2 \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium

# ---- 2. ProjectDiscovery + community binaries via GitHub releases -----------
# Pinned versions (verified to exist on GitHub releases).
ENV PD_SUBFINDER=2.6.6 \
    PD_HTTPX=1.6.9 \
    PD_NAABU=2.3.2 \
    PD_NUCLEI=3.3.5 \
    PD_KATANA=1.1.0 \
    PD_NOTIFY=1.0.9 \
    FFUF_VER=2.1.0 \
    TRUFFLEHOG_VER=3.82.13 \
    GITLEAKS_VER=8.21.2

WORKDIR /tmp/install
# Each tool download is wrapped with `|| log_warn` so a single bad URL never
# breaks the whole build. A final `command -v` summary lists what's missing.
RUN set -ux; \
    arch="${TARGETARCH:-amd64}"; \
    warn() { echo "[BUILD-WARN] $*" >&2; }; \
    dl() { curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"; }; \
    install_pd_zip() { name="$1"; ver="$2"; \
      if ! dl "https://github.com/projectdiscovery/${name}/releases/download/v${ver}/${name}_${ver}_linux_${arch}.zip" "${name}.zip"; then \
        warn "Skip ${name} v${ver} (download failed)"; return 0; fi; \
      mkdir -p "x_${name}"; unzip -qq -o "${name}.zip" -d "x_${name}" || { warn "unzip ${name} failed"; return 0; }; \
      bin="$(find "x_${name}" -maxdepth 3 -type f -name "${name}" | head -1)"; \
      [ -n "$bin" ] && install -m 0755 "$bin" "/usr/local/bin/${name}" || warn "${name} bin not found in archive"; \
      rm -rf "x_${name}" "${name}.zip"; }; \
    install_pd_zip subfinder "$PD_SUBFINDER"; \
    install_pd_zip httpx     "$PD_HTTPX"; \
    install_pd_zip naabu     "$PD_NAABU"; \
    install_pd_zip nuclei    "$PD_NUCLEI"; \
    install_pd_zip katana    "$PD_KATANA"; \
    install_pd_zip notify    "$PD_NOTIFY"; \
    # ffuf (tar.gz)
    if dl "https://github.com/ffuf/ffuf/releases/download/v${FFUF_VER}/ffuf_${FFUF_VER}_linux_${arch}.tar.gz" ffuf.tgz; then \
      mkdir -p ffuf-x && tar -xzf ffuf.tgz -C ffuf-x \
        && install -m 0755 ffuf-x/ffuf /usr/local/bin/ffuf; \
      rm -rf ffuf-x ffuf.tgz; \
    else warn "ffuf download failed"; fi; \
    # trufflehog (single binary in tarball)
    if dl "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VER}/trufflehog_${TRUFFLEHOG_VER}_linux_${arch}.tar.gz" th.tgz; then \
      tar -xzf th.tgz -C /usr/local/bin trufflehog || warn "trufflehog extract failed"; rm -f th.tgz; \
    else warn "trufflehog download failed"; fi; \
    # gitleaks (uses x64 not amd64 in artifact name)
    gl_arch="$arch"; [ "$arch" = "amd64" ] && gl_arch="x64"; \
    if dl "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VER}/gitleaks_${GITLEAKS_VER}_linux_${gl_arch}.tar.gz" gl.tgz; then \
      tar -xzf gl.tgz -C /usr/local/bin gitleaks || warn "gitleaks extract failed"; rm -f gl.tgz; \
    else warn "gitleaks download failed"; fi; \
    rm -rf /tmp/install/* ; \
    # Summary
    echo "=== Installed tool versions ==="; \
    for t in subfinder httpx naabu nuclei katana notify ffuf trufflehog gitleaks; do \
      if command -v "$t" >/dev/null 2>&1; then \
        echo "  [OK] $t"; \
      else \
        echo "  [MISSING] $t"; \
      fi; \
    done; \
    true

# ---- 2b. Install modern Go (Debian's 1.19 is too old for current PD/Tomnomnom tools) ----
ENV GO_VERSION=1.23.4
RUN set -ux; \
    arch="${TARGETARCH:-amd64}"; \
    curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" \
      && rm -rf /usr/local/go \
      && tar -C /usr/local -xzf /tmp/go.tgz \
      && rm -f /tmp/go.tgz \
      && /usr/local/go/bin/go version

# ---- 3. Go-installable tools (Tomnomnom + community) ------------------------
# Each `go install` is isolated with `|| true` so a single transient failure
# (network, removed module) doesn't abort the build.
ENV GOPATH=/root/go \
    PATH=/root/go/bin:/usr/local/go/bin:${PATH}
RUN set -ux; \
    for pkg in \
        github.com/tomnomnom/assetfinder@latest \
        github.com/tomnomnom/waybackurls@latest \
        github.com/tomnomnom/gf@latest \
        github.com/lc/gau/v2/cmd/gau@latest \
        github.com/lc/subjs@latest \
        github.com/PentestPad/subzy@latest \
        github.com/d3mondev/puredns/v2@latest \
        github.com/projectdiscovery/shuffledns/cmd/shuffledns@latest \
        github.com/sensepost/gowitness@latest \
    ; do \
      echo "[go install] $pkg"; \
      go install "$pkg" || echo "[BUILD-WARN] go install failed for $pkg"; \
    done; \
    if [ -d /root/go/bin ]; then cp -f /root/go/bin/* /usr/local/bin/ 2>/dev/null || true; fi; \
    echo "=== Go tools installed ==="; \
    for t in assetfinder waybackurls gf gau subjs subzy puredns shuffledns gowitness; do \
      if command -v "$t" >/dev/null 2>&1; then echo "  [OK] $t"; else echo "  [MISSING] $t"; fi; \
    done; \
    true

# ---- 4. gf patterns ---------------------------------------------------------
RUN set -eux; \
    git clone --depth=1 https://github.com/1ndianl33t/Gf-Patterns /opt/gf-patterns; \
    mkdir -p /root/.gf; \
    cp /opt/gf-patterns/*.json /root/.gf/ || true; \
    git clone --depth=1 https://github.com/tomnomnom/gf /opt/gf-src; \
    cp /opt/gf-src/examples/*.json /root/.gf/ 2>/dev/null || true

# ---- 5. Nuclei templates (preloaded) ----------------------------------------
RUN nuclei -update-templates -silent || true

# ---- 6. Resolvers + small wordlist (DNS brute) ------------------------------
RUN set -eux; \
    mkdir -p /opt/wordlists /opt/resolvers; \
    curl -fsSL https://raw.githubusercontent.com/trickest/resolvers/main/resolvers.txt \
      -o /opt/resolvers/resolvers.txt \
      || printf '1.1.1.1\n8.8.8.8\n9.9.9.9\n' > /opt/resolvers/resolvers.txt; \
    curl -fsSL https://raw.githubusercontent.com/n0kovo/n0kovo_subdomains/main/n0kovo_subdomains_small.txt \
      -o /opt/wordlists/subdomains.txt || true

# ---- 7. Node application ----------------------------------------------------
WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
