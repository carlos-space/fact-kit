#!/usr/bin/env bash
# Body checks for a message entering main (README.md, 開發). Two rules:
#   attribution  no AI-platform attribution: a line starting with Co-authored-by:, Assisted-by:,
#                Generated-by:, Made-with:, "Generated with" or "Made with" (list markers and emoji before
#                it allowed) that names an entry of ai-attribution-list.txt. Human co-authors pass.
#   units        a change touching two or more release units (the keys of .release-please-manifest.json)
#                declares "Coupled-Change: <why>" in the message's last paragraph. The manifest, not
#                release-please-config.json, is the source because a release branch shrinks the config to
#                one package while the manifest keeps every package, so main and release branches agree.
# The single source of both rules, called by the pr-message workflow on a pull request's title-and-body
# (squash-merge makes them the commit that enters main). There is no local hook: main only takes pull requests.
#
# usage: check-commit-body.sh [--only attribution|units] --message <file|-> [--diff <rev-range>]
#   --message        message from a file, or - for stdin; changed files from a diff
#                    (--diff origin/main...HEAD). Without --diff, the units rule is skipped.
# Exit 1 on a violation, each one reported on stderr.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$(dirname "$0")/../lib/common.sh"
usage() { die "usage: check-commit-body.sh [--only attribution|units] --message <file|-> [--diff <rev-range>]"; }

only="" msg_src="" files_from=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) only="${2:-}"; [[ "$only" == attribution || "$only" == units ]] || usage; shift 2 ;;
    --message) msg_src="${2:?}"; shift 2 ;;
    --diff) files_from="diff"; diff_range="${2:?}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$msg_src" ]] || usage

# Read the message before changing directory: a path is relative to where the caller started.
if [[ "$msg_src" == - ]]; then message="$(cat)"
else message="$(cat "$msg_src")"; fi
cd "$REPO_ROOT"
# A PR body arrives with CRLF line ends.
message="${message//$'\r'/}"

bad=0

check_attribution() {
  local list="$here/ai-attribution-list.txt" kind value line l words n=0 hit
  local -a names=() emails=()
  while read -r kind value; do
    case "$kind" in name) names+=("${value,,}") ;; email) emails+=("${value,,}") ;; esac
  done < <(grep -vE '^[[:space:]]*(#|$)' "$list")
  while IFS= read -r line; do
    n=$((n + 1))
    # Only a line that starts with an attribution form counts, after any leading list marker, emoji or
    # other non-alphanumeric characters ("- Co-authored-by:", "🤖 Generated with"). Prose that merely
    # contains "generated with" or "made with" mid-sentence is not attribution.
    l="${line,,}"; l="${l#"${l%%[[:alnum:]]*}"}"
    [[ "$l" =~ ^(co-authored-by|assisted-by|generated-by|made-with):|^(generated|made)\ with\  ]] || continue
    # whole-word match for names: every non-alphanumeric character becomes a space
    words=" ${l//[^[:alnum:]]/ } " hit=""
    for value in "${names[@]}"; do [[ "$words" == *" $value "* ]] && { hit="$value"; break; }; done
    if [[ -z "$hit" ]]; then
      for value in "${emails[@]}"; do [[ "$l" == *"$value"* ]] && { hit="$value"; break; }; done
    fi
    [[ -n "$hit" ]] || continue
    printf '%s\n' >&2 "✗ 第 $n 行是 AI 平台署名（名單項目 ${hit}）：$line" \
      "  commit 與 PR 不加 AI 平台署名，刪掉這一行。人類 co-author 照留。"
    bad=1
  done <<<"$message"
}

# The release unit of a file is the longest manifest path it sits under; "." would match every file, so
# it only takes files no other path claims.
check_units() {
  [[ -f "$MANIFEST" && -n "$files_from" ]] || return 0
  local -a paths=() files=()
  local f p best
  mapfile -t paths < <(jq -r 'keys[]' "$MANIFEST")
  case "$files_from" in
    diff) mapfile -t files < <(git diff --name-only "$diff_range") ;;
  esac
  declare -A units=()
  for f in "${files[@]}"; do
    [[ -n "$f" ]] || continue
    best=""
    for p in "${paths[@]}"; do
      p="${p%/}"
      if [[ "$p" == . || "$f" == "$p" || "$f" == "$p"/* ]] && (( ${#p} > ${#best} )); then best="$p"; fi
    done
    [[ -n "$best" ]] && units["$best"]=1
  done
  (( ${#units[@]} > 1 )) || return 0
  # the last paragraph after trailing blank lines and git's own "#" help lines are dropped
  if awk 'NF && !/^#/ { last = NR } { line[NR] = $0 }
          END { s = last; while (s > 1 && line[s - 1] ~ /[^[:space:]]/) s--; for (i = s; i <= last; i++) print line[i] }' \
       <<<"$message" | grep -qiE '^Coupled-Change:[[:space:]]*[^[:space:]]'; then
    return 0
  fi
  printf '%s\n' >&2 "✗ 這個變更改到 ${#units[@]} 個單元（$(printf '%s\n' "${!units[@]}" | sort | paste -sd, - | sed 's/,/、/g')），訊息最後一段沒有 Coupled-Change:" \
    "  本質上必須一起合時，在最後一段加 Coupled-Change: <為什麼必須一起合>；否則照 Parallel Change 拆成每個單元各一個 commit（README.md 的「開發」一節）。"
  bad=1
}

[[ "$only" == units ]] || check_attribution
[[ "$only" == attribution ]] || check_units
(( bad == 0 )) && printf '%s\n' "✓ 訊息內文符合規則${only:+（只查 ${only}）}"
exit "$bad"
