#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT_DIR}/backend/.env"

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

print_banner "[SETUP] Starting Linux deployment setup"
echo "[INFO] Project root: ${ROOT_DIR}"

print_banner "[STEP 1/5] Checking Docker dependencies"
if ! command -v docker >/dev/null 2>&1; then
  print_error_and_exit "Docker is not installed.
Install Docker Engine: https://docs.docker.com/engine/install/
After installation, verify with: docker --version"
fi

echo "[OK] Docker detected: $(docker --version)"

COMPOSE_COMMAND=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE_COMMAND="docker compose"
  echo "[OK] Docker Compose plugin detected."
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_COMMAND="docker-compose"
  echo "[OK] Standalone docker-compose detected: $(docker-compose --version)"
else
  print_error_and_exit "Docker Compose is not installed.
Install Docker Compose plugin: https://docs.docker.com/compose/install/linux/
Or install standalone docker-compose: https://docs.docker.com/compose/install/standalone/"
fi

print_banner "[STEP 2/5] Writing Gemini API key to backend/.env"
read -r -s -p "Enter your Gemini API Key: " GEMINI_API_KEY
echo ""

if [[ -z "${GEMINI_API_KEY}" ]]; then
  print_error_and_exit "Gemini API key cannot be empty."
fi

mkdir -p "$(dirname "${ENV_FILE}")"
printf "GEMINI_API_KEY=%s\n" "${GEMINI_API_KEY}" > "${ENV_FILE}"
echo "[OK] Wrote Gemini API key to ${ENV_FILE}"

print_banner "[STEP 3/5] Fixing shell script permissions"
chmod +x "${ROOT_DIR}/main.sh"
chmod +x "${ROOT_DIR}"/modules/*.sh
chmod +x "${ROOT_DIR}/setup_linux.sh"
echo "[OK] Executable permissions set for main.sh and modules/*.sh"

print_banner "[STEP 4/5] Converting CRLF to LF in all shell scripts"
while IFS= read -r sh_file; do
  sed -i 's/\r$//' "${sh_file}"
  echo "[FIXED] ${sh_file}"
done < <(find "${ROOT_DIR}" -type f -name "*.sh")
echo "[OK] Line ending normalization complete"

print_banner "[STEP 5/5] Starting Docker services"
cd "${ROOT_DIR}"
${COMPOSE_COMMAND} up --build -d

echo ""
echo "======================================================================"
echo "[SUCCESS] Bug Bounty stack is up and running"
echo "[DASHBOARD] http://localhost:5173"
echo "[API]       http://localhost:3000"
echo "======================================================================"
