#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="/tool-bin/user/bin:/home/node/bin:${PATH}"

SERVICE_NAME="agent-nexus-stable"
INSTANCE_HOME="${AGENT_NEXUS_STABLE_HOME:-/home/node/.agent-nexus-stable}"
RUNNER="${AGENT_NEXUS_STABLE_RUNNER:-${INSTANCE_HOME}/bin/run-stable.sh}"
STATE_DIR="${INSTANCE_HOME}/state"
LOG_DIR="${AGENT_NEXUS_STABLE_LOG_DIR:-/logs/agent-nexus-stable}"
LAUNCH_LOG="${LOG_DIR}/launch.log"
KEEPALIVE_PID_FILE="${STATE_DIR}/${SERVICE_NAME}.keepalive.pid"
CHILD_PID_FILE="${STATE_DIR}/${SERVICE_NAME}.pid"
KEEPALIVE_LOG="${LOG_DIR}/keepalive.log"
STDOUT_LOG="${LOG_DIR}/stdout.log"
STDERR_LOG="${LOG_DIR}/stderr.log"
RESTART_DELAY_SECONDS="${AGENT_NEXUS_STABLE_RESTART_DELAY_SECONDS:-10}"
CRASH_DELAY_SECONDS="${AGENT_NEXUS_STABLE_CRASH_DELAY_SECONDS:-60}"
MIN_UPTIME_SECONDS="${AGENT_NEXUS_STABLE_MIN_UPTIME_SECONDS:-15}"

AUTO_UPDATE_ENABLED="${AGENT_NEXUS_STABLE_AUTO_UPDATE_ENABLED:-1}"
AUTO_UPDATE_INTERVAL_SECONDS="${AGENT_NEXUS_STABLE_AUTO_UPDATE_INTERVAL_SECONDS:-600}"
AUTO_UPDATE_INITIAL_DELAY_SECONDS="${AGENT_NEXUS_STABLE_AUTO_UPDATE_INITIAL_DELAY_SECONDS:-60}"
AUTO_UPDATE_IDLE_SECONDS="${AGENT_NEXUS_STABLE_AUTO_UPDATE_IDLE_SECONDS:-300}"
AUTO_UPDATE_PROMOTE_SECONDS="${AGENT_NEXUS_STABLE_AUTO_UPDATE_PROMOTE_SECONDS:-180}"
AUTO_UPDATE_HEALTH_TIMEOUT_SECONDS="${AGENT_NEXUS_STABLE_AUTO_UPDATE_HEALTH_TIMEOUT_SECONDS:-120}"
AUTO_UPDATE_HEALTH_POLL_SECONDS="${AGENT_NEXUS_STABLE_AUTO_UPDATE_HEALTH_POLL_SECONDS:-5}"
AUTO_UPDATE_RELEASE_KEEP_COUNT="${AGENT_NEXUS_STABLE_AUTO_UPDATE_RELEASE_KEEP_COUNT:-3}"
AUTO_UPDATE_LOG_MAX_BYTES="${AGENT_NEXUS_STABLE_AUTO_UPDATE_LOG_MAX_BYTES:-10485760}"
AUTO_UPDATE_READINESS_COOLDOWN_SECONDS="${AGENT_NEXUS_STABLE_AUTO_UPDATE_READINESS_COOLDOWN_SECONDS:-3600}"
AUTO_UPDATE_BUILD_BAD_THRESHOLD="${AGENT_NEXUS_STABLE_AUTO_UPDATE_BUILD_BAD_THRESHOLD:-2}"

LEGACY_REPO_DIR="${AGENT_NEXUS_REPO_DIR:-/home/node/.codex/worktrees/e895/agent-nexus}"
SOURCE_DIR="${AGENT_NEXUS_STABLE_SOURCE_DIR:-${INSTANCE_HOME}/source/agent-nexus}"
RELEASES_DIR="${AGENT_NEXUS_STABLE_RELEASES_DIR:-${INSTANCE_HOME}/releases}"
CURRENT_RELEASE="${AGENT_NEXUS_STABLE_CURRENT_RELEASE:-${INSTANCE_HOME}/current}"
REMOTE_NAME="${AGENT_NEXUS_STABLE_REMOTE_NAME:-origin}"
REMOTE_REF="${AGENT_NEXUS_STABLE_REMOTE_REF:-main}"
REMOTE_URL="${AGENT_NEXUS_STABLE_REMOTE_URL:-}"
INSTALL_CMD="${AGENT_NEXUS_STABLE_INSTALL_CMD:-corepack pnpm install --frozen-lockfile}"
BUILD_CMD="${AGENT_NEXUS_STABLE_BUILD_CMD:-corepack pnpm build}"

AUTO_STATE_DIR="${STATE_DIR}/auto-update"
STABLE_HASH_FILE="${AUTO_STATE_DIR}/stable_hash"
PENDING_HASH_FILE="${AUTO_STATE_DIR}/pending_candidate_hash"
BAD_HASHES_FILE="${AUTO_STATE_DIR}/bad_hashes.tsv"
BUILD_FAILURES_FILE="${AUTO_STATE_DIR}/build_failures.tsv"
READINESS_COOLDOWNS_FILE="${AUTO_STATE_DIR}/readiness_cooldowns.tsv"
LAST_ERROR_FILE="${AUTO_STATE_DIR}/last_error.log"
RESTART_REQUEST_FILE="${AUTO_STATE_DIR}/restart-requested"
UPDATE_LOCK_DIR="${AUTO_STATE_DIR}/update.lock"

timestamp() {
  date -Is
}

log() {
  cap_log_file "${KEEPALIVE_LOG}"
  printf '[%s] %s\n' "$(timestamp)" "$*" >>"${KEEPALIVE_LOG}"
}

ensure_dirs() {
  mkdir -p "${STATE_DIR}" "${LOG_DIR}" "${AUTO_STATE_DIR}" "${RELEASES_DIR}"
  chmod 700 "${STATE_DIR}" "${LOG_DIR}" "${AUTO_STATE_DIR}" "${RELEASES_DIR}"
}

atomic_write() {
  local file="$1"
  local value="$2"
  local tmp="${file}.tmp.$$"
  printf '%s\n' "${value}" >"${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${file}"
}

sanitize_tsv() {
  printf '%s' "$*" | tr '\t\r\n' '   '
}

cap_log_file() {
  local file="$1"
  local max_bytes="${AUTO_UPDATE_LOG_MAX_BYTES}"
  [[ -e "${file}" ]] || return 0
  [[ "${max_bytes}" =~ ^[0-9]+$ ]] || return 0
  (( max_bytes > 0 )) || return 0
  local size keep tmp
  size="$(wc -c <"${file}" 2>/dev/null | tr -d '[:space:]' || printf '0')"
  [[ "${size}" =~ ^[0-9]+$ ]] || return 0
  (( size <= max_bytes )) && return 0
  keep="$((max_bytes / 2))"
  (( keep > 0 )) || keep="${max_bytes}"
  tmp="${file}.tmp.$$"
  tail -c "${keep}" "${file}" >"${tmp}" 2>/dev/null || return 0
  mv -f "${tmp}" "${file}"
}

cap_service_logs() {
  cap_log_file "${KEEPALIVE_LOG}"
  cap_log_file "${STDOUT_LOG}"
  cap_log_file "${STDERR_LOG}"
}

record_error() {
  local code="$1"
  local hash="${2:-}"
  local message="$3"
  local line
  line="$(printf '%s\t%s\t%s\t%s' "$(timestamp)" "${code}" "${hash}" "$(sanitize_tsv "${message}")")"
  atomic_write "${LAST_ERROR_FILE}" "${line}"
  log "auto_update_error code=${code} hash=${hash:-none} message=$(sanitize_tsv "${message}")"
}

read_pid() {
  local file="$1"
  if [[ ! -s "${file}" ]]; then
    return 1
  fi
  local pid
  pid="$(<"${file}")"
  if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
    printf '%s\n' "${pid}"
    return 0
  fi
  return 1
}

read_file() {
  local file="$1"
  [[ -s "${file}" ]] || return 1
  tr -d '[:space:]' <"${file}"
}

release_dir() {
  printf '%s/%s\n' "${RELEASES_DIR}" "$1"
}

release_hash_from_dir() {
  local dir="$1"
  read_file "${dir}/.agent-nexus-release-hash"
}

current_release_hash() {
  if [[ -L "${CURRENT_RELEASE}" || -d "${CURRENT_RELEASE}" ]]; then
    release_hash_from_dir "${CURRENT_RELEASE}" && return 0
  fi
  return 1
}

legacy_repo_hash() {
  git -C "${LEGACY_REPO_DIR}" rev-parse HEAD 2>/dev/null
}

stable_hash() {
  read_file "${STABLE_HASH_FILE}"
}

seed_stable_hash() {
  if [[ -s "${STABLE_HASH_FILE}" ]]; then
    return 0
  fi
  local hash=""
  hash="$(current_release_hash || true)"
  if [[ -z "${hash}" ]]; then
    hash="$(legacy_repo_hash || true)"
  fi
  if [[ -n "${hash}" ]]; then
    atomic_write "${STABLE_HASH_FILE}" "${hash}"
    log "auto_update_seed_stable hash=${hash}"
  fi
}

is_bad_hash() {
  local hash="$1"
  [[ -s "${BAD_HASHES_FILE}" ]] || return 1
  awk -F '\t' -v hash="${hash}" '$1 == hash { found = 1 } END { exit(found ? 0 : 1) }' "${BAD_HASHES_FILE}"
}

mark_bad_hash() {
  local hash="$1"
  local class="$2"
  local reason="$3"
  if is_bad_hash "${hash}"; then
    return 0
  fi
  printf '%s\t%s\t%s\t%s\n' "${hash}" "$(timestamp)" "${class}" "$(sanitize_tsv "${reason}")" >>"${BAD_HASHES_FILE}"
  chmod 600 "${BAD_HASHES_FILE}"
  log "auto_update_bad_hash hash=${hash} class=${class} reason=$(sanitize_tsv "${reason}")"
}

is_infra_exit() {
  local exit_code="$1"
  case "${exit_code}" in
    124 | 130 | 137 | 143)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

hash_count() {
  local file="$1"
  local hash="$2"
  [[ -s "${file}" ]] || {
    printf '0\n'
    return 0
  }
  awk -F '\t' -v hash="${hash}" '$1 == hash { value = $2 } END { print(value ? value : 0) }' "${file}"
}

set_hash_count() {
  local file="$1"
  local hash="$2"
  local count="$3"
  local tmp="${file}.tmp.$$"
  awk -F '\t' -v OFS='\t' -v hash="${hash}" -v count="${count}" '
    $1 == hash { print hash, count, systime(); seen = 1; next }
    { print }
    END { if (!seen) print hash, count, systime() }
  ' "${file}" 2>/dev/null >"${tmp}" || printf '%s\t%s\t%s\n' "${hash}" "${count}" "$(date +%s)" >"${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${file}"
}

clear_hash_count() {
  local file="$1"
  local hash="$2"
  [[ -s "${file}" ]] || return 0
  local tmp="${file}.tmp.$$"
  awk -F '\t' -v hash="${hash}" '$1 != hash { print }' "${file}" >"${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${file}"
}

record_build_failure() {
  local hash="$1"
  local exit_code="$2"
  local count
  count="$(hash_count "${BUILD_FAILURES_FILE}" "${hash}")"
  count="$((count + 1))"
  set_hash_count "${BUILD_FAILURES_FILE}" "${hash}" "${count}"
  log "auto_update_build_failure hash=${hash} exit=${exit_code} count=${count}/${AUTO_UPDATE_BUILD_BAD_THRESHOLD}"
  if (( count >= AUTO_UPDATE_BUILD_BAD_THRESHOLD )); then
    mark_bad_hash "${hash}" "build_failed" "${BUILD_CMD} failed exit=${exit_code} count=${count}"
  fi
}

readiness_cooldown_until() {
  local hash="$1"
  [[ -s "${READINESS_COOLDOWNS_FILE}" ]] || {
    printf '0\n'
    return 0
  }
  awk -F '\t' -v hash="${hash}" '$1 == hash { value = $2 } END { print(value ? value : 0) }' "${READINESS_COOLDOWNS_FILE}"
}

readiness_in_cooldown() {
  local hash="$1"
  local until
  until="$(readiness_cooldown_until "${hash}")"
  [[ "${until}" =~ ^[0-9]+$ ]] || return 1
  (( until > $(date +%s) ))
}

record_readiness_cooldown() {
  local hash="$1"
  local reason="$2"
  local until tmp
  until="$(($(date +%s) + AUTO_UPDATE_READINESS_COOLDOWN_SECONDS))"
  tmp="${READINESS_COOLDOWNS_FILE}.tmp.$$"
  awk -F '\t' -v OFS='\t' -v hash="${hash}" -v until="${until}" -v reason="$(sanitize_tsv "${reason}")" '
    $1 == hash { print hash, until, reason; seen = 1; next }
    { print }
    END { if (!seen) print hash, until, reason }
  ' "${READINESS_COOLDOWNS_FILE}" 2>/dev/null >"${tmp}" || printf '%s\t%s\t%s\n' "${hash}" "${until}" "$(sanitize_tsv "${reason}")" >"${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${READINESS_COOLDOWNS_FILE}"
  log "auto_update_readiness_cooldown hash=${hash} until=${until} reason=$(sanitize_tsv "${reason}")"
}

git_remote_url() {
  if [[ -n "${REMOTE_URL}" ]]; then
    printf '%s\n' "${REMOTE_URL}"
    return 0
  fi
  git -C "${LEGACY_REPO_DIR}" remote get-url "${REMOTE_NAME}" 2>/dev/null || printf 'git@github.com:moesin-lab/agent-nexus.git\n'
}

ensure_source_repo() {
  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "${SOURCE_DIR}")"
  local remote_url
  remote_url="$(git_remote_url)"

  if [[ -d "${LEGACY_REPO_DIR}/.git" || -f "${LEGACY_REPO_DIR}/.git" ]]; then
    if ! git clone --shared "${LEGACY_REPO_DIR}" "${SOURCE_DIR}" >>"${KEEPALIVE_LOG}" 2>&1; then
      record_error "source_clone_failed" "" "failed to clone from legacy repo"
      return 1
    fi
    git -C "${SOURCE_DIR}" remote set-url "${REMOTE_NAME}" "${remote_url}" >>"${KEEPALIVE_LOG}" 2>&1 || true
  else
    if ! git clone "${remote_url}" "${SOURCE_DIR}" >>"${KEEPALIVE_LOG}" 2>&1; then
      record_error "source_clone_failed" "" "failed to clone ${remote_url}"
      return 1
    fi
  fi
}

fetch_remote_hash() {
  ensure_source_repo || return 1
  if ! git -C "${SOURCE_DIR}" fetch --prune "${REMOTE_NAME}" "${REMOTE_REF}" >>"${KEEPALIVE_LOG}" 2>&1; then
    record_error "fetch_failed" "" "git fetch ${REMOTE_NAME} ${REMOTE_REF} failed"
    return 1
  fi
  git -C "${SOURCE_DIR}" rev-parse "${REMOTE_NAME}/${REMOTE_REF}" 2>>"${KEEPALIVE_LOG}"
}

remove_release_dir() {
  local dir="$1"
  if [[ ! -e "${dir}" ]]; then
    return 0
  fi
  if [[ -d "${SOURCE_DIR}/.git" ]]; then
    git -C "${SOURCE_DIR}" worktree remove --force "${dir}" >>"${KEEPALIVE_LOG}" 2>&1 && return 0
  fi
  rm -rf "${dir}"
}

validate_release() {
  local dir="$1"
  local entry="${dir}/packages/cli/dist/index.js"
  [[ -s "${entry}" ]] || return 1
  node --check "${entry}" >>"${KEEPALIVE_LOG}" 2>&1 || return 1
  node -e "const { createRequire } = require('node:module'); const r = createRequire(process.argv[1]); for (const m of ['discord.js', 'execa', 'pino']) r.resolve(m);" "${entry}" >>"${KEEPALIVE_LOG}" 2>&1
}

run_in_dir() {
  local dir="$1"
  local cmd="$2"
  (cd "${dir}" && bash -lc "${cmd}")
}

build_release() {
  local hash="$1"
  local dir
  dir="$(release_dir "${hash}")"
  if [[ -d "${dir}" ]] && validate_release "${dir}"; then
    return 0
  fi

  ensure_source_repo || return 1
  remove_release_dir "${dir}"
  git -C "${SOURCE_DIR}" worktree prune >>"${KEEPALIVE_LOG}" 2>&1 || true
  if ! git -C "${SOURCE_DIR}" worktree add --detach "${dir}" "${hash}" >>"${KEEPALIVE_LOG}" 2>&1; then
    record_error "release_worktree_failed" "${hash}" "git worktree add failed"
    remove_release_dir "${dir}"
    return 1
  fi

  if ! run_in_dir "${dir}" "${INSTALL_CMD}" >>"${KEEPALIVE_LOG}" 2>&1; then
    record_error "install_failed" "${hash}" "${INSTALL_CMD} failed"
    remove_release_dir "${dir}"
    return 1
  fi

  set +e
  run_in_dir "${dir}" "${BUILD_CMD}" >>"${KEEPALIVE_LOG}" 2>&1
  local build_exit=$?
  set -e
  if (( build_exit != 0 )); then
    record_error "build_failed" "${hash}" "${BUILD_CMD} failed exit=${build_exit}"
    if ! is_infra_exit "${build_exit}"; then
      record_build_failure "${hash}" "${build_exit}"
    fi
    remove_release_dir "${dir}"
    return 1
  fi

  atomic_write "${dir}/.agent-nexus-release-hash" "${hash}"
  if ! validate_release "${dir}"; then
    record_error "release_integrity_failed" "${hash}" "release validation failed"
    remove_release_dir "${dir}"
    return 1
  fi
  clear_hash_count "${BUILD_FAILURES_FILE}" "${hash}"
  log "auto_update_release_ready hash=${hash} dir=${dir}"
}

snapshot_release_from_dir() {
  local hash="$1"
  local source="$2"
  local dir tmp
  dir="$(release_dir "${hash}")"
  if [[ -d "${dir}" ]] && validate_release "${dir}"; then
    return 0
  fi
  [[ -d "${source}" ]] || return 1
  tmp="${dir}.snapshot.$$"
  rm -rf "${tmp}"
  mkdir -p "${tmp}"
  if ! (cd "${source}" && tar --exclude='./.git' -cf - .) | (cd "${tmp}" && tar -xf -); then
    rm -rf "${tmp}"
    record_error "stable_snapshot_failed" "${hash}" "failed to snapshot ${source}"
    return 1
  fi
  atomic_write "${tmp}/.agent-nexus-release-hash" "${hash}"
  if ! validate_release "${tmp}"; then
    rm -rf "${tmp}"
    record_error "stable_snapshot_invalid" "${hash}" "snapshot ${source} is not a valid release"
    return 1
  fi
  remove_release_dir "${dir}"
  mv "${tmp}" "${dir}"
  log "auto_update_stable_snapshot hash=${hash} source=${source}"
}

ensure_stable_release() {
  local hash source
  hash="$(stable_hash || true)"
  [[ -n "${hash}" ]] || return 1
  if [[ -d "$(release_dir "${hash}")" ]] && validate_release "$(release_dir "${hash}")"; then
    return 0
  fi
  source=""
  if [[ -d "${CURRENT_RELEASE}" ]] && [[ "$(current_release_hash || true)" == "${hash}" ]]; then
    source="${CURRENT_RELEASE}"
  elif [[ "$(legacy_repo_hash || true)" == "${hash}" ]]; then
    source="${LEGACY_REPO_DIR}"
  fi
  if [[ -n "${source}" ]]; then
    snapshot_release_from_dir "${hash}" "${source}"
    return $?
  fi
  record_error "stable_release_missing" "${hash}" "no valid release or snapshot source for stable hash"
  return 1
}

switch_current_release() {
  local hash="$1"
  local dir tmp_link
  dir="$(release_dir "${hash}")"
  validate_release "${dir}" || {
    record_error "switch_release_invalid" "${hash}" "release validation failed before switch"
    return 1
  }
  tmp_link="${CURRENT_RELEASE}.tmp.$$"
  ln -sfn "${dir}" "${tmp_link}"
  mv -Tf "${tmp_link}" "${CURRENT_RELEASE}"
  log "auto_update_current_switched hash=${hash}"
}

file_mtime() {
  local file="$1"
  [[ -e "${file}" ]] || {
    printf '0\n'
    return 0
  }
  stat -c '%Y' "${file}" 2>/dev/null || printf '0\n'
}

child_has_descendants() {
  local pid="$1"
  [[ -n "$(pgrep -P "${pid}" 2>/dev/null || true)" ]]
}

service_idle() {
  local pid="$1"
  kill -0 "${pid}" 2>/dev/null || return 1
  child_has_descendants "${pid}" && return 1
  local now newest stderr_mtime
  now="$(date +%s)"
  newest="$(file_mtime "${STDOUT_LOG}")"
  stderr_mtime="$(file_mtime "${STDERR_LOG}")"
  if (( stderr_mtime > newest )); then
    newest="${stderr_mtime}"
  fi
  (( now - newest >= AUTO_UPDATE_IDLE_SECONDS ))
}

request_child_restart() {
  local pid="$1"
  atomic_write "${RESTART_REQUEST_FILE}" "$(timestamp)"
  kill -TERM "${pid}" 2>/dev/null || true
  log "auto_update_restart_requested pid=${pid}"
}

try_switch_candidate() {
  local hash="$1"
  local child_pid
  child_pid="$(read_pid "${CHILD_PID_FILE}" || true)"

  if [[ -n "${child_pid}" ]] && ! service_idle "${child_pid}"; then
    log "auto_update_pending_wait_idle hash=${hash} child=${child_pid}"
    return 0
  fi

  ensure_stable_release || return 1
  switch_current_release "${hash}" || return 1
  atomic_write "${PENDING_HASH_FILE}" "${hash}"

  if [[ -n "${child_pid}" ]]; then
    request_child_restart "${child_pid}"
  else
    log "auto_update_pending_no_child hash=${hash}"
  fi
}

prune_releases() {
  local stable pending current keep_count
  stable="$(stable_hash || true)"
  pending="$(read_file "${PENDING_HASH_FILE}" || true)"
  current="$(current_release_hash || true)"
  keep_count="${AUTO_UPDATE_RELEASE_KEEP_COUNT}"
  find "${RELEASES_DIR}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn \
    | awk -v stable="${stable}" -v pending="${pending}" -v current="${current}" -v keep="${keep_count}" '
        {
          path=$2
          n=split(path, parts, "/")
          hash=parts[n]
          if (hash == stable || hash == pending || hash == current) next
          seen++
          if (seen > keep) print path
        }' \
    | while IFS= read -r dir; do
        [[ -n "${dir}" ]] || continue
        log "auto_update_prune_release dir=${dir}"
        remove_release_dir "${dir}"
      done
}

check_for_update() {
  local remote_hash current_hash
  remote_hash="$(fetch_remote_hash || true)"
  [[ -n "${remote_hash}" ]] || return 0

  if is_bad_hash "${remote_hash}"; then
    log "auto_update_skip_bad_hash hash=${remote_hash}"
    return 0
  fi
  if readiness_in_cooldown "${remote_hash}"; then
    log "auto_update_skip_readiness_cooldown hash=${remote_hash} until=$(readiness_cooldown_until "${remote_hash}")"
    return 0
  fi

  current_hash="$(current_release_hash || legacy_repo_hash || true)"
  if [[ "${remote_hash}" == "${current_hash}" ]]; then
    log "auto_update_no_update hash=${remote_hash}"
    return 0
  fi

  if ! build_release "${remote_hash}"; then
    return 0
  fi

  try_switch_candidate "${remote_hash}" || true
  prune_releases || true
}

with_update_lock() {
  if ! mkdir "${UPDATE_LOCK_DIR}" 2>/dev/null; then
    local holder=""
    holder="$(read_file "${UPDATE_LOCK_DIR}/pid" || true)"
    if [[ -n "${holder}" ]] && ! kill -0 "${holder}" 2>/dev/null; then
      rm -rf "${UPDATE_LOCK_DIR}"
      mkdir "${UPDATE_LOCK_DIR}" 2>/dev/null || {
        log "auto_update_skip lock=busy"
        return 0
      }
      log "auto_update_stale_lock_reclaimed pid=${holder}"
    else
      log "auto_update_skip lock=busy"
      return 0
    fi
  fi
  atomic_write "${UPDATE_LOCK_DIR}/pid" "$$"
  local rc=0
  "$@" || rc=$?
  rm -rf "${UPDATE_LOCK_DIR}" 2>/dev/null || true
  return "${rc}"
}

update_loop() {
  sleep "${AUTO_UPDATE_INITIAL_DELAY_SECONDS}"
  while true; do
    with_update_lock check_for_update || true
    sleep "${AUTO_UPDATE_INTERVAL_SECONDS}"
  done
}

log_size() {
  local file="$1"
  [[ -e "${file}" ]] || {
    printf '0\n'
    return 0
  }
  wc -c <"${file}" | tr -d '[:space:]'
}

new_log_contains() {
  local file="$1"
  local offset="$2"
  local pattern="$3"
  [[ -e "${file}" ]] || return 1
  tail -c "+$((offset + 1))" "${file}" 2>/dev/null | grep -q "${pattern}"
}

wait_for_candidate_health() {
  local pid="$1"
  local hash="$2"
  local stdout_offset="$3"
  local deadline now
  deadline="$(($(date +%s) + AUTO_UPDATE_HEALTH_TIMEOUT_SECONDS))"
  while true; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      record_error "candidate_exited_before_readiness" "${hash}" "candidate exited before readiness"
      return 1
    fi
    if new_log_contains "${STDOUT_LOG}" "${stdout_offset}" "engine_started" \
      && new_log_contains "${STDOUT_LOG}" "${stdout_offset}" "discord_ready"; then
      log "auto_update_candidate_healthy hash=${hash}"
      return 0
    fi
    now="$(date +%s)"
    if (( now >= deadline )); then
      record_error "candidate_readiness_timeout" "${hash}" "candidate did not emit readiness before timeout"
      record_readiness_cooldown "${hash}" "candidate did not emit readiness before timeout"
      return 1
    fi
    sleep "${AUTO_UPDATE_HEALTH_POLL_SECONDS}"
  done
}

promote_candidate_later() {
  local hash="$1"
  local pid="$2"
  (
    sleep "${AUTO_UPDATE_PROMOTE_SECONDS}"
    if kill -0 "${pid}" 2>/dev/null \
      && [[ "$(read_file "${PENDING_HASH_FILE}" || true)" == "${hash}" ]] \
      && [[ "$(current_release_hash || true)" == "${hash}" ]]; then
      atomic_write "${STABLE_HASH_FILE}" "${hash}"
      rm -f "${PENDING_HASH_FILE}"
      log "auto_update_candidate_promoted hash=${hash}"
      prune_releases || true
    fi
  ) &
}

rollback_to_stable() {
  local hash
  hash="$(stable_hash || true)"
  if [[ -z "${hash}" ]]; then
    record_error "rollback_failed" "" "stable hash is missing"
    return 1
  fi
  if ! switch_current_release "${hash}"; then
    record_error "rollback_failed" "${hash}" "failed to switch back to stable release"
    return 1
  fi
  rm -f "${PENDING_HASH_FILE}" "${RESTART_REQUEST_FILE}"
  log "auto_update_rollback hash=${hash}"
}

status() {
  local keepalive_pid child_pid current stable pending
  keepalive_pid="$(read_pid "${KEEPALIVE_PID_FILE}" || true)"
  child_pid="$(read_pid "${CHILD_PID_FILE}" || true)"
  current="$(current_release_hash || true)"
  stable="$(stable_hash || true)"
  pending="$(read_file "${PENDING_HASH_FILE}" || true)"
  if [[ -n "${keepalive_pid}" ]]; then
    printf '%s keepalive running pid=%s\n' "${SERVICE_NAME}" "${keepalive_pid}"
  else
    printf '%s keepalive stopped\n' "${SERVICE_NAME}"
  fi
  if [[ -n "${child_pid}" ]]; then
    printf '%s child running pid=%s\n' "${SERVICE_NAME}" "${child_pid}"
  else
    printf '%s child stopped\n' "${SERVICE_NAME}"
  fi
  printf '%s current_hash=%s stable_hash=%s pending_hash=%s auto_update=%s\n' \
    "${SERVICE_NAME}" "${current:-unknown}" "${stable:-unknown}" "${pending:-none}" "${AUTO_UPDATE_ENABLED}"
}

stop_service() {
  local keepalive_pid child_pid
  child_pid="$(read_pid "${CHILD_PID_FILE}" || true)"
  keepalive_pid="$(read_pid "${KEEPALIVE_PID_FILE}" || true)"
  if [[ -n "${child_pid}" ]]; then
    kill "${child_pid}" 2>/dev/null || true
  fi
  if [[ -n "${keepalive_pid}" && "${keepalive_pid}" != "$$" ]]; then
    kill "${keepalive_pid}" 2>/dev/null || true
  fi
  rm -f "${CHILD_PID_FILE}" "${KEEPALIVE_PID_FILE}"
}

start_service() {
  ensure_dirs

  local keepalive_pid
  keepalive_pid="$(read_pid "${KEEPALIVE_PID_FILE}" || true)"
  if [[ -n "${keepalive_pid}" ]]; then
    printf '%s keepalive already running pid=%s\n' "${SERVICE_NAME}" "${keepalive_pid}" >&2
    status
    return 0
  fi

  rm -f "${CHILD_PID_FILE}" "${KEEPALIVE_PID_FILE}"
  setsid -f "$0" run </dev/null >>"${LAUNCH_LOG}" 2>&1
  sleep 1
  status
}

run_loop() {
  ensure_dirs
  seed_stable_hash
  if [[ -d "${UPDATE_LOCK_DIR}" ]]; then
    local lock_holder
    lock_holder="$(read_file "${UPDATE_LOCK_DIR}/pid" || true)"
    if [[ -z "${lock_holder}" ]] || ! kill -0 "${lock_holder}" 2>/dev/null; then
      rm -rf "${UPDATE_LOCK_DIR}"
      log "auto_update_stale_lock_removed_on_start pid=${lock_holder:-unknown}"
    fi
  fi

  if existing="$(read_pid "${KEEPALIVE_PID_FILE}" || true)" && [[ -n "${existing}" && "${existing}" != "$$" ]]; then
    printf '%s keepalive already running pid=%s\n' "${SERVICE_NAME}" "${existing}" >&2
    exit 1
  fi

  printf '%s\n' "$$" >"${KEEPALIVE_PID_FILE}"
  chmod 600 "${KEEPALIVE_PID_FILE}"

  local child_pid="" update_pid=""
  cleanup() {
    log "stopping keepalive"
    if [[ -n "${update_pid}" ]] && kill -0 "${update_pid}" 2>/dev/null; then
      kill "${update_pid}" 2>/dev/null || true
      wait "${update_pid}" 2>/dev/null || true
    fi
    if [[ -n "${child_pid}" ]] && kill -0 "${child_pid}" 2>/dev/null; then
      kill "${child_pid}" 2>/dev/null || true
      wait "${child_pid}" 2>/dev/null || true
    fi
    rm -f "${CHILD_PID_FILE}" "${KEEPALIVE_PID_FILE}"
    rmdir "${UPDATE_LOCK_DIR}" 2>/dev/null || true
  }
  trap cleanup EXIT
  trap 'exit 0' INT TERM

  if [[ "${AUTO_UPDATE_ENABLED}" == "1" ]]; then
    update_loop &
    update_pid="$!"
    log "auto_update_loop_started pid=${update_pid} interval=${AUTO_UPDATE_INTERVAL_SECONDS}s"
  fi

  while true; do
    local started_at finished_at uptime exit_code delay started_hash pending_hash stdout_offset restart_requested
    started_at="$(date +%s)"
    cap_service_logs
    stdout_offset="$(log_size "${STDOUT_LOG}")"
    started_hash="$(current_release_hash || legacy_repo_hash || true)"
    pending_hash="$(read_file "${PENDING_HASH_FILE}" || true)"
    log "starting ${RUNNER} hash=${started_hash:-unknown}"
    "${RUNNER}" >>"${STDOUT_LOG}" 2>>"${STDERR_LOG}" &
    child_pid="$!"
    printf '%s\n' "${child_pid}" >"${CHILD_PID_FILE}"
    chmod 600 "${CHILD_PID_FILE}"

    local candidate_start_failed="0"
    if [[ -n "${pending_hash}" && "${pending_hash}" == "${started_hash}" ]]; then
      if wait_for_candidate_health "${child_pid}" "${pending_hash}" "${stdout_offset}"; then
        promote_candidate_later "${pending_hash}" "${child_pid}"
      else
        candidate_start_failed="1"
        rollback_to_stable || true
        kill "${child_pid}" 2>/dev/null || true
      fi
    fi

    set +e
    wait "${child_pid}"
    exit_code="$?"
    set -e

    rm -f "${CHILD_PID_FILE}"
    finished_at="$(date +%s)"
    uptime="$((finished_at - started_at))"
    delay="${RESTART_DELAY_SECONDS}"
    restart_requested="0"
    local still_pending_hash
    still_pending_hash="$(read_file "${PENDING_HASH_FILE}" || true)"
    if [[ -e "${RESTART_REQUEST_FILE}" ]]; then
      restart_requested="1"
      rm -f "${RESTART_REQUEST_FILE}"
    elif [[ "${candidate_start_failed}" == "1" ]]; then
      if is_infra_exit "${exit_code}"; then
        record_error "candidate_start_infra_exit" "${started_hash}" "candidate exited with infra-like code ${exit_code}"
      else
        mark_bad_hash "${started_hash}" "candidate_quick_crash" "candidate failed before readiness exit=${exit_code}"
      fi
    elif [[ -n "${still_pending_hash}" && "${still_pending_hash}" == "${started_hash}" && (( uptime < AUTO_UPDATE_PROMOTE_SECONDS )) ]]; then
      if is_infra_exit "${exit_code}"; then
        record_error "candidate_exit_before_promote_infra" "${still_pending_hash}" "candidate exited before promote with infra-like code ${exit_code}"
      else
        mark_bad_hash "${still_pending_hash}" "candidate_quick_crash" "candidate exited before promote uptime=${uptime}s exit=${exit_code}"
      fi
      rollback_to_stable || true
    elif (( uptime < MIN_UPTIME_SECONDS )); then
      delay="${CRASH_DELAY_SECONDS}"
    fi
    log "child exited code=${exit_code} uptime=${uptime}s restart_in=${delay}s restart_requested=${restart_requested}"
    sleep "${delay}"
  done
}

case "${1:-run}" in
  start)
    start_service
    ;;
  run)
    run_loop
    ;;
  status)
    ensure_dirs
    status
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    sleep 1
    start_service
    ;;
  update-once)
    ensure_dirs
    seed_stable_hash
    with_update_lock check_for_update
    ;;
  *)
    printf 'usage: %s [start|run|status|stop|restart|update-once]\n' "$0" >&2
    exit 2
    ;;
esac
