#!/usr/bin/env bash
# Move a release train forward to a later stage: alpha → beta → rc → ga. Forward only: a target at or
# before the train's current stage is refused.
#
# usage: advance-release.sh --line X.Y [--to beta|rc|ga] [--product-version X.Y.Z] [--yes] [--dry-run]
#   --to               target stage; default is the stage after the current one. A stage with no
#                      environment in this repo is skipped forward to the next one that has one
#                      (scripts/lib/release-stages.sh), so the train may land later than asked.
#   --product-version  the Release Plan's product version; required when the train reaches ga.
#
# The current stage is what the train's config declares: its prerelease-type while in prerelease mode,
# ga once it has left. Entering a prerelease stage writes one Release-As commit per unit that already
# shipped a prerelease in this train (1.2.0-alpha.3 → 1.2.0-beta.1), then moves prerelease-type to the
# new stage. The Release-As is what switches the stage: for a version that is already a prerelease,
# release-please only bumps its trailing number and never reads prerelease-type. Units still on a
# stable version have not released in this train; when they do, prerelease-type gives them the new
# stage. Reaching ga hands over to finalize-release.sh --phase ga, unchanged.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
cd "$REPO_ROOT"

line="" requested="" product=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --line) line="$2"; shift 2 ;;
    --to) requested="$2"; shift 2 ;;
    --product-version) product="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,${/^#/!q; p;}' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ "$line" =~ ^[0-9]+\.[0-9]+$ ]] || die "--line 需為 X.Y"
[[ -z "$requested" ]] || is_stage "$requested" || die "--to 需為 ${RELEASE_STAGES[*]:1}"
branch="release/v$line"

require_clean_tree
[[ "$(current_branch)" == "$branch" ]] || die "請在 $branch 上執行（目前 $(current_branch)）"
train_sync "$branch"

current="$(train_stage)"
ci="$(stage_index "$current")"
(( ci + 1 < ${#RELEASE_STAGES[@]} )) \
  || die "$branch 已是 ga，沒有下一個階段。GA 中途失敗要重跑時用 finalize-release.sh --line $line --phase ga --product-version X.Y.Z"
[[ -n "$requested" ]] || requested="${RELEASE_STAGES[$((ci + 1))]}"
ri="$(stage_index "$requested")"
if (( ri < ci )); then die "不能往回：$branch 目前在 ${current}，目標 ${requested} 在它之前"; fi
if (( ri == ci )); then
  hint=""
  [[ -n "$(git rev-list "origin/$branch..HEAD" 2>/dev/null)" ]] \
    && hint="；本機比 origin/$branch 多出 commit，前一次推進若只差推送，執行 git push origin $branch"
  die "$branch 已在 ${current}，只能往後推進${hint}"
fi
target="$(stage_first_available "$requested")"
[[ "$target" == "$requested" ]] || info "階段 ${requested} 沒有環境（$(stage_env "$requested")），跳到 ${target}"
log "${branch}：${current} → ${target}"

if [[ "$target" == ga ]]; then
  [[ -n "$product" ]] || die "推進到 ga 要帶 --product-version X.Y.Z（交給 finalize-release.sh --phase ga）"
  log "交給 finalize-release.sh --phase ga"
  DRY_RUN="$DRY_RUN" ASSUME_YES="$ASSUME_YES" \
    exec bash "$(dirname "$0")/finalize-release.sh" --line "$line" --phase ga --product-version "$product"
fi

train_gates "$branch" "$line" "$target"
log "進入 ${target}：已發過 prerelease 的單元從 .1 開始"
train_release_as "$branch" "$target"
ptype="$(stage_prerelease_type "$target")"
if (( DRY_RUN )); then info "[dry-run] ${CONFIG}：prerelease-type → ${ptype}"; else
  tmp="$(mktemp)"; jq --arg t "$ptype" '."prerelease-type" = $t' "$CONFIG" > "$tmp" && mv "$tmp" "$CONFIG"
  git add "$CONFIG"
  git commit -q -m "chore($branch): enter $target" -m "prerelease-type 改為 ${ptype}：之後才第一次發版的單元也從 ${target} 開始。"
fi
external "$(remote_target)" git push origin "$branch"
printf '\n'
info "下一步：合併 Release PR → 各單元 -${target}.1 tag → 部署到 $(stage_env "$target")。"
later="${RELEASE_STAGES[*]:$(( $(stage_index "$target") + 1 ))}"
info "再推進：advance-release.sh --line $line [--to ${later// /|}]；到 ga 時加 --product-version X.Y.Z"
