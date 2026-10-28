#!/usr/bin/env bash
# Open a release train: create release/v<line> and scope release-please to the train's units, in
# prerelease mode at the starting stage, so every listed unit gets its own X.Y.Z-<stage>.N while the
# train stabilises. advance-release.sh moves the train on (alpha → beta → rc → ga, forward only).
#
# usage: cut-release.sh --line X.Y --units web,api,sdk-core [--stage alpha|beta|rc|ga] [--from main|vX.Y.Z] [--yes] [--dry-run]
#   --line   product line the train belongs to; names the branch release/v<line>
#   --units  comma list of units in this train (components of release-please-config.json).
#            A unit with no commits since its last tag simply does not release.
#   --stage  starting stage; default is the first stage this repo has an environment for. A stage
#            without an environment is skipped forward (scripts/lib/release-stages.sh). ga skips
#            prerelease mode: the train's first Release PR is already the final version.
#   --from   base: main (default) or a product tag such as v1.3.0, for a post-GA hotfix train.
#            Once the line has a product tag (vX.Y.Z), --from must name its latest one.
#
# No version is pinned here: release-please's prerelease strategy derives each unit's own next
# version from its own commits, which is what keeps unit versions independent of the product marker.
# The config's prerelease-type is "<stage>.1", which the strategy appends to a unit's first bump
# (1.3.1 + feat → 1.4.0-alpha.1); a unit that never shipped starts at initial-version <line>.0-<stage>.1.
set -euo pipefail
source "$(dirname "$0")/../lib/common.sh"
cd "$REPO_ROOT"

line="" units_csv="" from="main" requested_stage=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --line) line="$2"; shift 2 ;;
    --units) units_csv="$2"; shift 2 ;;
    --stage) requested_stage="$2"; shift 2 ;;
    --from) from="$2"; shift 2 ;;
    --yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,${/^#/!q; p;}' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[[ -n "$line" && -n "$units_csv" ]] || die "--line 與 --units 必填"
[[ "$line" =~ ^[0-9]+\.[0-9]+$ ]] || die "--line 需為 X.Y（產品線）"
branch="release/v$line"
IFS=, read -r -a units <<<"$units_csv"
if [[ -n "$requested_stage" ]]; then
  is_stage "$requested_stage" || die "--stage 需為 ${RELEASE_STAGES[*]}"
  stage="$(stage_first_available "$requested_stage")"
  [[ "$stage" == "$requested_stage" ]] \
    || info "階段 ${requested_stage} 沒有環境（$(stage_env "$requested_stage")），改從 ${stage} 開始"
else
  stage="$(stage_first_available "${RELEASE_STAGES[0]}")"
fi

require_clean_tree
run git fetch --prune --tags origin
declare -a existing=()
while IFS= read -r b; do [[ -n "$b" ]] && existing+=("$b"); done < <(release_branches)
[[ -z "${existing[0]:-}" ]] || die "遠端已有 release 分支：${existing[*]}（不變式：任一時刻 ≤ 1 條）"
git rev-parse -q --verify "refs/heads/$branch" >/dev/null && die "本地已有 ${branch}，先刪除或改用它"

# A line that already shipped takes patches only, and a patch must continue from the line's latest
# GA: cut from main it carries everything merged since, cut from an older tag it drops a shipped fix.
# Refuse instead of picking the tag, so the base stays explicit.
shipped="$(product_latest_tag "$line")"
if [[ -n "$shipped" && "$from" != "$shipped" ]]; then
  die "產品線 ${line} 已發布到 ${shipped}，修補發布要接在它後面（目前起點 ${from}）：改帶 --from ${shipped}。修正已在 main 時，切出後把它 cherry-pick 進 ${branch}。要發下一個 minor 就改用新的 --line"
fi
if [[ "$from" == "main" ]]; then base="origin/main"; else
  git rev-parse -q --verify "refs/tags/$from" >/dev/null || die "起點 tag 不存在：${from}（發布後 hotfix 需自產品 tag 如 v1.3.0 重建，不從 main）"
  base="$from"
fi
for u in "${units[@]}"; do unit_path "$u" >/dev/null || die "unit 不存在：$u"; done
# Two expansions, applied until neither adds anything:
#   - workspace dependents: node-workspace only bumps packages present in the config, so a dependent
#     left out of the train would keep a dependency range pointing at the old version.
#   - linked-versions group members: the group shares one version, so it boards all or nothing.
# They feed each other (a pulled-in dependent may belong to a group, and a group member has its own
# dependents), hence the fixpoint loop rather than one pass of each.
declare -a added
while :; do
  added=()
  while IFS= read -r d; do
    [[ -n "$d" ]] || continue
    in_array "$d" "${units[@]}" && continue
    units+=("$d"); added+=("$d"); info "自動納入相依單元：$d"
  done < <(workspace_dependents "${units[@]}")
  while IFS= read -r g; do
    [[ -n "$g" ]] || continue
    in_array "$g" "${units[@]}" && continue
    units+=("$g"); added+=("$g"); info "自動納入共享版號群組成員：$g"
  done < <(linked_group_members "${units[@]}")
  (( ${#added[@]} )) || break
done
declare -a paths
for u in "${units[@]}"; do paths+=("$(unit_path "$u")"); done

log "切 ${branch}（base ${base}），train 單元：${units[*]}"
run git switch -c "$branch" "$base"

# A train rebuilt from a product tag also rewinds scripts/ and the config to that tag; refresh the
# release tooling from main so the train runs the current flow, not the flow of the day it shipped.
if [[ "$from" != "main" ]]; then
  log "自 main 更新發布工具（重建的 train 否則會跑該 tag 當時的舊腳本）"
  run git checkout origin/main -- scripts "$CONFIG"
  if (( DRY_RUN )); then info "[dry-run] 以 main 的 manifest 為底補上非 train 單元版號"; else
    keep="$(printf '"%s",' "${paths[@]}")"; keep="[${keep%,}]"
    tmp="$(mktemp)"
    jq -s --argjson keep "$keep" '.[0] * (.[1] | with_entries(select(.key as $k | $keep | index($k))))' \
      <(git show origin/main:"$MANIFEST") "$MANIFEST" > "$tmp" && mv "$tmp" "$MANIFEST"
    git add scripts "$CONFIG" "$MANIFEST" 2>/dev/null || true
  fi
fi

# Where this train should start counting commits.
#
# release-please walks main's history newest-first and stops at the previous release's commit. A
# commit that landed on main while the previous train was stabilising is *older* than that release
# commit, so the walk never reaches it and the change is silently dropped from the next release.
# Anchoring on the previous train's branch point instead makes those commits visible again. The
# cost is that a fix already shipped by the previous train can appear once more in this train's
# changelog, which is the usual behaviour of release-branch workflows (a patch released on the
# maintenance line is also "new" relative to the line it was cut from).
# 前一次發布的切點由它自己在合回時寫進 commit 訊息的 Release-Train-Base trailer，不靠事後反推：
# 發布分支以 squash 合回，main 上沒有可取父節點的 merge commit，且切點本來就是切分支當下已知的事實。
if [[ "$from" == "main" ]]; then
  # 修補發布自產品 tag 重建，它合回時寫進 main 的 Release-Train-Base 指向發布分支上的 commit，而發布分支
  # 以 squash 合回，那個 commit 不是 main 的祖先。以它為界，回溯永遠走不到而重新計入全部歷史：
  # 實測 v1.4 因此把已發布過的破壞性變更再算一次，版號自 2.1.0 誤跳 3.0.0。逐筆往回找，取第一個
  # 確實在起點歷史上的切點。
  prev_cut=""
  while IFS= read -r c; do
    [[ -n "$c" ]] || continue
    if git merge-base --is-ancestor "$c" "$base" 2>/dev/null; then prev_cut="$c"; break; fi
    info "略過非主線切點 ${c:0:7}（修補發布自 tag 重建，其切點不在 main 上）"
  done < <(git log origin/main --format='%(trailers:key=Release-Train-Base,valueonly)' -n 200 2>/dev/null | grep -E '^[0-9a-f]{7,40}$' || true)
else
  # 自產品 tag（如 v1.3.0）重建的修補發布：該 tag 之前的內容全部已發布，起算點就是它本身。
  # 沿用前一次發布的切點會把上一版已發過的功能重新計入，把 patch 誤算成 minor。
  prev_cut="$(git rev-parse "${from}^{commit}")"
fi

# A unit that has never shipped has no release for the prerelease strategy to bump from, so
# release-please would take initial-version verbatim (1.0.0 when unset). Start it at this line, in
# the same format the stage gives every other unit.
if [[ "$stage" == ga ]]; then initial="${line}.0"; else initial="${line}.0-$(stage_prerelease_type "$stage")"; fi
declare -a fresh=() fresh_release_as=()
for u in "${units[@]}"; do
  if unit_released "$u"; then
    if [[ "$stage" == ga ]]; then info "${u}：目前 $(manifest_version "$(unit_path "$u")")，正式版號由 release-please 依 commit 計算"
    else info "${u}：目前 $(manifest_version "$(unit_path "$u")")，第一個版本由 release-please 依 commit 計算為 X.Y.Z-$(stage_prerelease_type "$stage")"; fi
    continue
  fi
  fresh+=("$(unit_path "$u")"); info "${u}：首次發布，起始版號 ${initial}，tag $(unit_tag "$(unit_path "$u")" "$initial")"
  # release-please's python and rust strategies hard-code their first version as 0.1.0 and never read
  # initial-version (strategies/python.js and rust.js, initialReleaseVersion). For those a Release-As commit
  # sets the first version instead; it only steers the next release, and the marker it needs is dropped at
  # merge-back like the ones advance-release.sh writes.
  case "$(unit_release_type "$(unit_path "$u")")" in
    python | rust) fresh_release_as+=("$u"); info "${u}：release-type 不讀 initial-version，切線時另寫 Release-As: ${initial}" ;;
  esac
done
freshj="[]"; (( ${#fresh[@]} )) && { freshj="$(printf '"%s",' "${fresh[@]}")"; freshj="[${freshj%,}]"; }

# scope the config to the train; a prerelease stage switches it to prerelease mode, ga leaves it as is
keep="$(printf '"%s",' "${paths[@]}")"; keep="[${keep%,}]"
tmp="$(mktemp)"
keepc="$(printf '"%s",' "${units[@]}")"; keepc="[${keepc%,}]"
ptype=""; [[ "$stage" == ga ]] || ptype="$(stage_prerelease_type "$stage")"
jq --argjson keep "$keep" --argjson keepc "$keepc" --arg sha "${prev_cut:-}" \
  --argjson fresh "$freshj" --arg initial "$initial" --arg ptype "$ptype" '
  .packages |= with_entries(select(.key as $k | $keep | index($k)))
  | .packages |= with_entries(if (.key as $k | $fresh | index($k)) then .value."initial-version" = $initial else . end)
  # 群組成員未全數納入的 linked-versions 條目會指向設定中不存在的 component，一併移除
  | .plugins = ((.plugins // []) | map(
      select(.type != "linked-versions" or (((.components // []) - $keepc) | length) == 0)))
  | if $ptype == "" then . else .versioning = "prerelease" | ."prerelease-type" = $ptype | .prerelease = true end
  | if $sha == "" then . else ."last-release-sha" = $sha end
' "$CONFIG" > "$tmp"
if [[ -n "${prev_cut:-}" ]]; then
  [[ "$from" == "main" ]] && info "起算點：${prev_cut:0:7}（前一次發布自 main 的切點）" || info "起算點：${prev_cut:0:7}（${from}）"
else
  info "起算點：無前一次發布，自歷史起頭計算"
fi
info "起始階段：${stage}（環境 $(stage_env "$stage")；本倉庫有環境的階段：$(stages_available | paste -sd ' ' -)）"
if (( DRY_RUN )); then info "[dry-run] $CONFIG 會縮為："; jq -c '{versioning, "prerelease-type", prerelease, "last-release-sha", plugins: [.plugins[].type], packages: (.packages|keys), initial: [.packages | to_entries[] | select(.value."initial-version") | "\(.key)=\(.value."initial-version")"]}' "$tmp"; rm -f "$tmp"; else mv "$tmp" "$CONFIG"; fi
run git add "$CONFIG"
base_sha="$(git rev-parse "${base}^{commit}")"
if [[ "$stage" == ga ]]; then
  body="起始階段 ga：不進 prerelease 模式，release-please 於本分支直接為各單元計算正式版號。"
else
  body="起始階段 ${stage}：release-please 於本分支以 prerelease 模式為各單元計算自身的 -${stage}.N 版號；advance-release.sh 往後推進，到 ga 時由 finalize-release.sh 收斂。"
fi
run git commit -q -m "chore($branch): open train at $stage with ${units[*]}" -m "$body

Release-Train-Base: $base_sha"
for u in ${fresh_release_as[@]+"${fresh_release_as[@]}"}; do
  if (( DRY_RUN )); then info "  [dry-run] ${u}：Release-As ${initial} 的標記 commit"; continue; fi
  release_as_commit "$branch" "$u" "$(unit_path "$u")" "$initial"
done

log "推送分支（觸發 release-please → 各單元的 Release PR）"
external "$(remote_target)" git push -u origin "$branch"
printf '\n'
if [[ "$stage" == ga ]]; then
  info "下一步：合併 Release PR → 各單元正式 tag → finalize-release.sh --line $line --phase merge-back --product-version X.Y.Z"
else
  info "下一步：合併 Release PR → 各單元 -${stage}.N tag → 部署到 $(stage_env "$stage")。"
  info "hotfix：hotfix/<issue>-<kebab> 從 $branch 切、PR 合回 ${branch}（Refs #N），每次合入再開一次 Release PR。"
  later="${RELEASE_STAGES[*]:$(( $(stage_index "$stage") + 1 ))}"
  info "推進：advance-release.sh --line $line [--to ${later// /|}]；到 ga 時加 --product-version X.Y.Z"
fi
