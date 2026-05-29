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
      golang-go \
      chromium chromium-sandbox fonts-liberation \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
      libxcomposite1 libxrandr2 libgbm1 libpango-1.0-0 libasound2 \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium

# ---- 2. ProjectDiscovery + community binaries via GitHub releases -----------
ENV PD_SUBFINDER=2.6.6 \
    PD_HTTPX=1.6.9 \
    PD_NAABU=2.3.2 \
    PD_NUCLEI=3.3.5 \
    PD_KATANA=1.1.0 \
    PD_NOTIFY=1.0.10 \
    FFUF_VER=2.1.0 \
    GOWITNESS_VER=3.0.5 \
    TRUFFLEHOG_VER=3.82.13 \
    GITLEAKS_VER=8.21.2

WORKDIR /tmp/install
RUN set -eux; \
    arch="${TARGETARCH:-amd64}"; \
    dl() { curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"; }; \
    install_pd_zip() { name="$1"; ver="$2"; \
      dl "https://github.com/projectdiscovery/${name}/releases/download/v${ver}/${name}_${ver}_linux_${arch}.zip" "${name}.zip"; \
      mkdir -p "x_${name}"; unzip -qq -o "${name}.zip" -d "x_${name}"; \
      bin="$(find "x_${name}" -maxdepth 3 -type f -name "${name}" | head -1)"; \
      install -m 0755 "$bin" "/usr/local/bin/${name}"; \
      rm -rf "x_${name}" "${name}.zip"; }; \
    install_pd_zip subfinder "$PD_SUBFINDER"; \
    install_pd_zip httpx     "$PD_HTTPX"; \
    install_pd_zip naabu     "$PD_NAABU"; \
    install_pd_zip nuclei    "$PD_NUCLEI"; \
    install_pd_zip katana    "$PD_KATANA"; \
    install_pd_zip notify    "$PD_NOTIFY"; \
    # ffuf (tar.gz)
    dl "https://github.com/ffuf/ffuf/releases/download/v${FFUF_VER}/ffuf_${FFUF_VER}_linux_${arch}.tar.gz" ffuf.tgz; \
    mkdir -p ffuf-x && tar -xzf ffuf.tgz -C ffuf-x; \
    install -m 0755 ffuf-x/ffuf /usr/local/bin/ffuf; \
    rm -rf ffuf-x ffuf.tgz; \
    # gowitness (single static binary)
    dl "https://github.com/sensepost/gowitness/releases/download/${GOWITNESS_VER}/gowitness-${GOWITNESS_VER}-linux-${arch}" /usr/local/bin/gowitness; \
    chmod +x /usr/local/bin/gowitness; \
    # trufflehog (v3 by trufflesecurity) — single binary in tarball
    dl "https://github.com/trufflesecurity/trufflehog/releases/download/v${TRUFFLEHOG_VER}/trufflehog_${TRUFFLEHOG_VER}_linux_${arch}.tar.gz" th.tgz; \
    tar -xzf th.tgz -C /usr/local/bin trufflehog; rm -f th.tgz; \
    # gitleaks (note: gitleaks uses x64 not amd64 in artifact name)
    gl_arch="$arch"; [ "$arch" = "amd64" ] && gl_arch="x64"; \
    dl "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VER}/gitleaks_${GITLEAKS_VER}_linux_${gl_arch}.tar.gz" gl.tgz; \
    tar -xzf gl.tgz -C /usr/local/bin gitleaks; rm -f gl.tgz; \
    rm -rf /tmp/install/*

# ---- 3. Go-installable tools (Tomnomnom + community) ------------------------
ENV GOPATH=/root/go \
    PATH=/root/go/bin:/usr/local/go/bin:${PATH}
RUN set -eux; \
    go install github.com/tomnomnom/assetfinder@latest; \
    go install github.com/tomnomnom/waybackurls@latest; \
    go install github.com/tomnomnom/gf@latest; \
    go install github.com/lc/gau/v2/cmd/gau@latest; \
    go install github.com/lc/subjs@latest; \
    go install github.com/PentestPad/subzy@latest; \
    go install github.com/d3mondev/puredns/v2@latest; \
    go install github.com/projectdiscovery/shuffledns/cmd/shuffledns@latest; \
    cp /root/go/bin/* /usr/local/bin/

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
