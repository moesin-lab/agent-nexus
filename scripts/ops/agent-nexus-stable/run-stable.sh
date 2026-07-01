#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="/tool-bin/user/bin:/home/node/bin:${PATH}"

INSTANCE_HOME="${AGENT_NEXUS_STABLE_HOME:-/home/node/.agent-nexus-stable}"
CURRENT_RELEASE="${AGENT_NEXUS_STABLE_CURRENT_RELEASE:-${INSTANCE_HOME}/current}"
LEGACY_REPO_DIR="${AGENT_NEXUS_REPO_DIR:-/home/node/.codex/worktrees/e895/agent-nexus}"

if [[ -s "${CURRENT_RELEASE}/packages/cli/dist/index.js" ]]; then
  REPO_DIR="${CURRENT_RELEASE}"
else
  REPO_DIR="${LEGACY_REPO_DIR}"
fi

CLI_ENTRY="${AGENT_NEXUS_CLI_ENTRY:-${REPO_DIR}/packages/cli/dist/index.js}"

cd "${REPO_DIR}"
exec node "${CLI_ENTRY}" --home "${INSTANCE_HOME}"
