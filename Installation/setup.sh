#!/usr/bin/env bash
#
# Automated installer for the HP Tourism staging environment.
# Run on a fresh Ubuntu 22.04/24.04 VM as root.
#
# Usage:
#   sudo bash Installation/setup.sh

set -euo pipefail

# -------------------------------------------------------------
# Configuration – adjust if needed before running the script
# -------------------------------------------------------------
APP_USER="hptourism"
APP_DIR="/opt/hptourism/app"
LOCAL_STORAGE="/var/lib/hptourism/storage"
SERVICE_NAME="hptourism-stg"
DB_NAME="hptourism_stg"
DB_USER="hptourism_user"
DB_PASSWORD="${DB_PASSWORD:-hptourism_secure_password}"
NODE_VERSION="22.x"
NODE_PORT="${NODE_PORT:-4000}"
SERVER_NAME="${SERVER_NAME:-staging.osipl.dev}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/var/log/hptourism-installer"
LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d-%H%M%S).log"

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "Installer log: $LOG_FILE"

# -------------------------------------------------------------
# Helper functions
# -------------------------------------------------------------
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

ensure_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (use sudo)." >&2
    exit 1
  fi
}

create_system_user() {
  if id "$APP_USER" >/dev/null 2>&1; then
    echo "User $APP_USER already exists."
  else
    adduser --disabled-password --gecos "" "$APP_USER"
  fi
}

install_packages() {
  echo "Installing OS packages…"
  apt-get update
  apt-get install -y curl ca-certificates gnupg build-essential nginx postgresql postgresql-contrib \
    redis-server zip unzip jq git logrotate fail2ban gettext-base

  # Node.js (NodeSource)
  if ! command_exists node || [[ "$(node -v)" != v22* ]]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION} | bash -
    apt-get install -y nodejs
  fi
}

setup_directories() {
  echo "Creating application directories…"
  mkdir -p "$APP_DIR" "$LOCAL_STORAGE"
  rsync -a --delete --exclude node_modules "$REPO_ROOT/" "$APP_DIR/"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR" "$LOCAL_STORAGE"
}

setup_postgres() {
  echo "Configuring PostgreSQL…"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}';"

  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1 || \
    sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
}

setup_env_file() {
  echo "Preparing .env…"
  if [[ ! -f "$APP_DIR/.env" ]]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    cat <<EOF >> "$APP_DIR/.env"
NODE_ENV=production
DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}
OBJECT_STORAGE_MODE=local
LOCAL_OBJECT_DIR=${LOCAL_STORAGE}
LOCAL_MAX_UPLOAD_BYTES=$((20 * 1024 * 1024))
PORT=${NODE_PORT}
EOF
  fi
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
}

install_node_modules() {
  echo "Installing Node dependencies…"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm install"
}

run_migrations_and_build() {
  echo "Running database migrations…"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm run db:push"
  echo "Building production bundle…"
  sudo -u "$APP_USER" bash -c "cd '$APP_DIR' && npm run build"
}

configure_systemd_service() {
  echo "Creating systemd service…"
  cat >/etc/systemd/system/${SERVICE_NAME}.service <<SERVICE
[Unit]
Description=HP Tourism Portal (stg-rc3)
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Environment=NODE_ENV=production
EnvironmentFile=${APP_DIR}/.env
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) dist/index.js
Restart=on-failure
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
SERVICE

  systemctl daemon-reload
  systemctl enable ${SERVICE_NAME}.service
  systemctl restart ${SERVICE_NAME}.service
}

configure_nginx() {
  echo "Configuring nginx…"
  local template="${APP_DIR}/Installation/nginx-site.conf"
  local target="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
  if [[ ! -f "$template" ]]; then
    echo "Warning: nginx template not found at ${template}, skipping nginx configuration."
    return
  fi

  export SERVER_NAME NODE_PORT APP_DIR_PATH="$APP_DIR"
  envsubst '${SERVER_NAME} ${NODE_PORT} ${APP_DIR_PATH}' < "$template" > "$target"
  ln -sf "$target" "/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  rm -f /etc/nginx/sites-enabled/default || true
  nginx -t
  systemctl enable nginx
  systemctl restart nginx
}

print_summary() {
  cat <<SUMMARY

Installation complete.

- App directory: ${APP_DIR}
- Local storage: ${LOCAL_STORAGE}
- Systemd service: ${SERVICE_NAME}
- Nginx server name: ${SERVER_NAME}
- Database: ${DB_NAME} (owner ${DB_USER})

Check service status with:
  sudo systemctl status ${SERVICE_NAME}

SUMMARY
}

# -------------------------------------------------------------
# Main flow
# -------------------------------------------------------------
ensure_root
install_packages
create_system_user
setup_directories
setup_postgres
setup_env_file
install_node_modules
run_migrations_and_build
configure_systemd_service
configure_nginx
print_summary
