#!/usr/bin/env bash
# sync-claude-skills.sh — 按 skills.manifest 把 skills/<name>/ 挂接到 .claude/skills/<name>
# 挂接策略（宽容 fallback）：
#   - 若 skills/<name>/harnesses/claude-code/ 存在 → 挂该目录（per-harness 执行器，优先）
#   - 否则挂 skills/<name>/（通用入口，兼容未拆分 per-harness 的 skill）
# 幂等；清理 target 以 `../../skills/` 开头但不在 manifest 中的幽灵 symlink。
# 只动自己管的，不碰用户私放。
#
# 见 docs/dev/process/skill-setup.md。
set -euo pipefail
shopt -s nullglob

repo_root="$(git rev-parse --show-toplevel)"
manifest="$repo_root/skills.manifest"
target_dir="$repo_root/.claude/skills"

[ -f "$manifest" ] || { echo "missing: $manifest" >&2; exit 1; }

mkdir -p "$target_dir"

# 读 manifest 到 wanted 集合
declare -A wanted=()
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  [ -z "$line" ] && continue
  wanted["$line"]=1
done < "$manifest"

# 补齐 / 纠正
for name in "${!wanted[@]}"; do
  src="$repo_root/skills/$name"
  link="$target_dir/$name"
  [ -d "$src" ] || { echo "skip: $src not a directory" >&2; continue; }
  # 优先挂 per-harness 执行器；不存在则回退挂通用入口
  if [ -d "$src/harnesses/claude-code" ]; then
    rel_target="../../skills/$name/harnesses/claude-code"
  else
    rel_target="../../skills/$name"
  fi
  if [ -L "$link" ]; then
    rm "$link"
  elif [ -e "$link" ]; then
    echo "refuse: $link exists and is not a symlink — manually resolve" >&2
    exit 1
  fi
  ln -s "$rel_target" "$link"
  echo "linked: $link -> $rel_target"
done

# 清理幽灵：target 指向 ../../skills/* 但 name 不在 manifest
for link in "$target_dir"/*; do
  [ -L "$link" ] || continue
  name="$(basename "$link")"
  target="$(readlink "$link")"
  [[ "$target" == "../../skills/"* ]] || continue
  [ -n "${wanted[$name]:-}" ] && continue
  rm "$link"
  echo "removed ghost: $link"
done
