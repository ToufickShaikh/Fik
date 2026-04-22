#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT_DIR}/backend/.env"
COMPOSE_COMMAND=()
IS_PODMAN=false
USE_SUDO_FOR_COMPOSE=false
USER_IN_CONTAINER_GROUP=false
CURRENT_USER="${SUDO_USER:-$(id -un)}"

print_banner() {
  local title="$1"
  echo ""
  echo "======================================================================"
  echo "${title}"
  echo "======================================================================"
}

print_error_and_exit() {
  local message="$1"
  echo ""
  echo "[ERROR] ${message}"
  exit 1
}

print_missing_package_json_and_exit() {
  local missing_file="$1"
  echo ""
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "ERROR: package.json missing! Did you forget to git add and push from Windows?"
  echo "Missing file: ${missing_file}"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  exit 1
}

print_banner "[SETUP] Starting Linux deployment setup"
echo "[INFO] Project root: ${ROOT_DIR}"

print_banner "[STEP 1/8] Checking Docker dependencies"
if ! command -v docker >/dev/null 2>&1; then
  print_error_and_exit "Docker is not installed.
Install Docker Engine: https://docs.docker.com/engine/install/
After installation, verify with: docker --version"
fi

DOCKER_VERSION_OUTPUT="$(docker --version 2>&1 || true)"
DOCKER_INFO_OUTPUT="$(docker info 2>&1 || true)"

if [[ -z "${DOCKER_VERSION_OUTPUT}" ]]; then
  print_error_and_exit "Docker CLI did not return a version string. Check your Docker/Podman installation."
fi

echo "[OK] Docker detected: ${DOCKER_VERSION_OUTPUT}"

if echo "${DOCKER_VERSION_OUTPUT}
${DOCKER_INFO_OUTPUT}" | grep -Eiq 'podman|emulate docker'; then
  IS_PODMAN=true
  echo "[INFO] Podman-backed Docker emulation detected."
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_COMMAND=(docker compose)
  echo "[OK] Docker Compose plugin detected."
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_COMMAND=(docker-compose)
  echo "[OK] Standalone docker-compose detected: $(docker-compose --version)"
else
  print_error_and_exit "Docker Compose is not installed.
Install Docker Compose plugin: https://docs.docker.com/compose/install/linux/
Or install standalone docker-compose: https://docs.docker.com/compose/install/standalone/"
fi

print_banner "[STEP 2/8] Checking required package manifests"
if [[ ! -f "${ROOT_DIR}/backend/package.json" ]]; then
  print_missing_package_json_and_exit "${ROOT_DIR}/backend/package.json"
fi

if [[ ! -f "${ROOT_DIR}/frontend/package.json" ]]; then
  print_missing_package_json_and_exit "${ROOT_DIR}/frontend/package.json"
fi

echo "[OK] Found backend/package.json and frontend/package.json"

print_banner "[STEP 3/8] Checking docker/podman group permissions"
CURRENT_GROUPS="$(id -nG "${CURRENT_USER}" 2>/dev/null || id -nG)"
echo "[INFO] Current user: ${CURRENT_USER}"
if echo " ${CURRENT_GROUPS} " | grep -Eq ' (docker|podman) '; then
  USER_IN_CONTAINER_GROUP=true
  echo "[OK] Current user belongs to docker/podman group."
else
  echo "[WARN] Current user is not in docker or podman group."
  echo "[WARN] Suggestion: run this script with sudo or add your user to one of these groups."
fi

if [[ "${EUID}" -ne 0 && "${USER_IN_CONTAINER_GROUP}" != "true" ]]; then
  USE_SUDO_FOR_COMPOSE=true
fi

print_banner "[STEP 4/8] Handling Podman socket (if Podman is detected)"
if [[ "${IS_PODMAN}" == "true" ]]; then
  if ! command -v systemctl >/dev/null 2>&1; then
    print_error_and_exit "systemctl is required to start podman.socket but was not found."
  fi

  echo "[INFO] Enabling Podman socket: systemctl enable --now podman.socket"
  if [[ "${EUID}" -eq 0 ]]; then
    systemctl enable --now podman.socket
  else
    if ! command -v sudo >/dev/null 2>&1; then
      print_error_and_exit "sudo is required to enable podman.socket for non-root users."
    fi
    sudo systemctl enable --now podman.socket
  fi

  export DOCKER_HOST="unix:///run/podman/podman.sock"
  echo "[OK] DOCKER_HOST set to ${DOCKER_HOST}"

  if [[ ! -S "/run/podman/podman.sock" ]]; then
    print_error_and_exit "Podman socket not found at /run/podman/podman.sock after enable/start."
  fi

  if [[ "${EUID}" -ne 0 && ! -w "/run/podman/podman.sock" ]]; then
    USE_SUDO_FOR_COMPOSE=true
    echo "[WARN] Socket is not writable by current user. docker compose will run with sudo."
  fi
else
  echo "[INFO] Podman emulation not detected. Skipping podman.socket setup."
fi

print_banner "[STEP 5/8] Writing Gemini API key to backend/.env"
read -r -s -p "Enter your Gemini API Key: " GEMINI_API_KEY
echo ""

if [[ -z "${GEMINI_API_KEY}" ]]; then
  print_error_and_exit "Gemini API key cannot be empty."
fi

mkdir -p "$(dirname "${ENV_FILE}")"
printf "GEMINI_API_KEY=%s\n" "${GEMINI_API_KEY}" > "${ENV_FILE}"
echo "[OK] Wrote Gemini API key to ${ENV_FILE}"

print_banner "[STEP 6/8] Fixing shell script permissions"
chmod +x "${ROOT_DIR}/main.sh"
chmod +x "${ROOT_DIR}"/modules/*.sh
chmod +x "${ROOT_DIR}/setup_linux.sh"
echo "[OK] Executable permissions set for main.sh and modules/*.sh"

print_banner "[STEP 7/8] Converting CRLF to LF in all shell scripts"
while IFS= read -r sh_file; do
  sed -i 's/\r$//' "${sh_file}"
  echo "[FIXED] ${sh_file}"
done < <(find "${ROOT_DIR}" -type f -name "*.sh")
echo "[OK] Line ending normalization complete"

print_banner "[STEP 8/8] Starting container services"
cd "${ROOT_DIR}"
if [[ "${USE_SUDO_FOR_COMPOSE}" == "true" ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    print_error_and_exit "sudo is required to run compose with elevated privileges."
  fi

  echo "[INFO] Running compose command with sudo to avoid socket permission issues."
  if [[ -n "${DOCKER_HOST:-}" ]]; then
    sudo env DOCKER_HOST="${DOCKER_HOST}" "${COMPOSE_COMMAND[@]}" up --build -d
  else
    sudo "${COMPOSE_COMMAND[@]}" up --build -d
  fi
else
  "${COMPOSE_COMMAND[@]}" up --build -d
fi

echo ""
echo "======================================================================"
echo "[SUCCESS] Bug Bounty stack is up and running"
echo "[DASHBOARD] http://localhost:5173"
echo "[API]       http://localhost:3000"
echo "======================================================================"
