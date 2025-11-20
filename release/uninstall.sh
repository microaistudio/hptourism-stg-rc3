#!/usr/bin/env bash
#
# Teardown script for the homestay-r1 stack. Run as root when you want to
# remove all components installed by Installation/setup.sh.

set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-homestay-r1}"
APP_ROOT="${APP_ROOT:-/opt/hptourism}"
APP_DIR="${APP_DIR:-${APP_ROOT}/app}"
LOCAL_STORAGE_ROOT="${LOCAL_STORAGE_ROOT:-/var/lib/hptourism}"
LOCAL_STORAGE="${LOCAL_STORAGE:-${LOCAL_STORAGE_ROOT}/storage}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/hptourism}"
APP_USER="${APP_USER:-hptourism}"
DB_NAME="${DB_NAME:-hptourism_stg}"
DB_USER="${DB_USER:-hptourism_user}"
KEEP_DB="${KEEP_DB:-false}"
KEEP_APP_USER="${KEEP_APP_USER:-false}"
LOG_DIR="/var/log/hptourism-installer"

log() {
  printf '[%s] %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$*"
}

ensure_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "This script must be run as root (sudo)." >&2
    exit 1
  fi
}

stop_unit() {
  local unit="$1"
  if systemctl list-unit-files | cut -d' ' -f1 | grep -qx "$unit"; then
    systemctl stop "$unit" || true
    systemctl disable "$unit" || true
  fi
}

remove_unit_file() {
  local path="$1"
  if [[ -f "$path" ]]; then
    rm -f "$path"
    systemctl daemon-reload
  fi
}

cleanup_nginx() {
  local site="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
  local link="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  if [[ -e "$site" || -e "$link" ]]; then
    log "Removing nginx site ${SERVICE_NAME}"
    rm -f "$site" "$link"
    if command -v nginx >/dev/null 2>&1 && nginx -t; then
      systemctl reload nginx || true
    fi
  fi
}

drop_database_objects() {
  if [[ "${KEEP_DB}" == "true" ]]; then
    log "KEEP_DB=true – skipping database drop."
    return
  fi

  if ! command -v psql >/dev/null 2>&1 || ! id postgres >/dev/null 2>&1; then
    log "PostgreSQL client or postgres user not available; skipping database cleanup."
    return
  fi

  log "Dropping database ${DB_NAME} (if present)"
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
    sudo -u postgres psql -c "DROP DATABASE ${DB_NAME};"
  else
    log "Database ${DB_NAME} not found."
  fi

  log "Dropping role ${DB_USER} (if present)"
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1; then
    sudo -u postgres psql -c "DROP ROLE ${DB_USER};"
  else
    log "Role ${DB_USER} not found."
  fi
}

remove_directories() {
  log "Removing application directories"
  rm -rf "$APP_DIR" "$LOCAL_STORAGE" "$BACKUP_ROOT" "$LOG_DIR"
  for dir in "$APP_ROOT" "$LOCAL_STORAGE_ROOT"; do
    if [[ -d "$dir" ]]; then
      rmdir --ignore-fail-on-non-empty "$dir" || true
    fi
  done
}

remove_app_user() {
  if [[ "${KEEP_APP_USER}" == "true" ]]; then
    log "KEEP_APP_USER=true – skipping user removal."
    return
  fi
  if id "$APP_USER" >/dev/null 2>&1; then
    log "Removing system user ${APP_USER}"
    userdel -r "$APP_USER" 2>/dev/null || userdel "$APP_USER" || true
  fi
}

main() {
  ensure_root
  log "Stopping services"
  stop_unit "${SERVICE_NAME}.service"
  stop_unit "${SERVICE_NAME}-backup.timer"
  stop_unit "${SERVICE_NAME}-backup.service"

  log "Removing systemd unit files"
  remove_unit_file "/etc/systemd/system/${SERVICE_NAME}.service"
  remove_unit_file "/etc/systemd/system/${SERVICE_NAME}-backup.service"
  remove_unit_file "/etc/systemd/system/${SERVICE_NAME}-backup.timer"

  cleanup_nginx
  drop_database_objects
  remove_directories
  remove_app_user

  log "Teardown complete."
}

main "$@"
