#!/usr/bin/env bash
# Release stages of a train and the steps that move a train between them. Sourced by common.sh;
# do not execute.
#
# A train walks alpha → beta → rc → ga, forward only. Each stage deploys to one environment:
#   alpha → dev, beta → beta, rc → staging, ga → production
# A stage exists in this repo when it has an environment, judged across the whole repo:
#   - service units: ops/charts/<unit>/values-<env>.yaml
#   - mobile apps (MOBILE_UNITS): apps/<app>/release-channels.json, an object from stage to store
#     channel, e.g. {"beta": "testflight-external", "rc": "testflight-internal", "ga": "app-store"}.
#     A stage that is absent or maps to an empty string has no channel.
#   - package units: a unit in release-please-config.json that publishes to a registry or by tag
#     (unit_registry) and is not a private npm package. The registry is the environment of every
#     prerelease stage, because alpha, beta and rc all publish (publish-units.sh). Deployment stays
#     per declaration: a unit without a stage's values file or channel is not deployed there.
# ga always exists: every train ends there. A stage with no environment is skipped, so a repo with
# only staging and production starts its trains at rc, and one with only production and no publishable
# package goes straight to ga.
#
#   STAGE_ENV_ROOT  where the environment declarations and the package units are read from (default REPO_ROOT)

RELEASE_STAGES=(alpha beta rc ga)

stage_env() { # stage_env <stage> → environment name
  case "$1" in
    alpha) printf '%s\n' dev ;;
    beta) printf '%s\n' beta ;;
    rc) printf '%s\n' staging ;;
    ga) printf '%s\n' production ;;
    *) return 1 ;;
  esac
}

stage_index() { # stage_index <stage> → 0-based position in RELEASE_STAGES
  local i
  for i in "${!RELEASE_STAGES[@]}"; do
    [[ "${RELEASE_STAGES[$i]}" == "$1" ]] && { printf '%s\n' "$i"; return 0; }
  done
  return 1
}

is_stage() { stage_index "$1" >/dev/null; }

# mobile_channel <app> <stage> → the store channel the app ships <stage> builds to; fails when the app
# declares none. A declaration file that is not a JSON object stops the run instead of reading as "no
# channel", because silently skipping a stage would change where a release goes.
mobile_channel() {
  local f="${STAGE_ENV_ROOT:-$REPO_ROOT}/apps/$1/release-channels.json" ch
  [[ -f "$f" ]] || return 1
  jq -e 'type == "object"' "$f" >/dev/null 2>&1 || die "$f 不是 JSON 物件（格式：{\"<階段>\": \"<通道>\"}）"
  ch="$(jq -r --arg s "$2" '.[$s] // empty' "$f")"
  [[ -n "$ch" ]] || return 1
  printf '%s\n' "$ch"
}

# unit_registry <dir> → npm | pypi | crates | go | swift, from the file the unit directory carries; fails when none.
# publish-units.sh picks the registry with this same function. go and swift have no registry to upload to: the
# tag release-please creates is the release record, and the package is mirrored into its own repository, whose
# tag the Go proxy and SwiftPM read.
unit_registry() {
  if [[ -f "$1/Package.swift" ]]; then printf '%s\n' swift
  elif [[ -f "$1/go.mod" ]]; then printf '%s\n' go
  elif [[ -f "$1/package.json" ]]; then printf '%s\n' npm
  elif [[ -f "$1/pyproject.toml" ]]; then printf '%s\n' pypi
  elif [[ -f "$1/Cargo.toml" ]]; then printf '%s\n' crates
  else return 1; fi
}

# unit_content_paths <dir> → the paths that make up the unit, one per line: the directory itself, because every
# unit, the Swift package included, is a complete package in its own directory.
unit_content_paths() { printf '%s\n' "$1"; }

# has_publishable_units <root> → whether the repo at <root> has a package unit that publishes: an
# entry of its release-please-config.json (the paths release-please.yml hands to
# publish.yml) with a registry file, other than a private npm package, which npm refuses to publish.
has_publishable_units() {
  local root="$1" cfg="$1/$CONFIG" p
  [[ -f "$cfg" ]] || return 1
  while IFS= read -r p; do
    [[ -n "$p" ]] || continue
    case "$(unit_registry "$root/$p")" in
      npm) [[ "$(jq -r '.private // false' "$root/$p/package.json")" == true ]] || return 0 ;;
      pypi | crates | go | swift) return 0 ;;
    esac
  done < <(jq -r '.packages // {} | keys[]' "$cfg")
  return 1
}

stage_has_env() { # stage_has_env <stage>
  local stage="$1" root="${STAGE_ENV_ROOT:-$REPO_ROOT}" env app
  [[ "$stage" == ga ]] && return 0
  env="$(stage_env "$stage")" || return 1
  has_publishable_units "$root" && return 0
  compgen -G "$root/ops/charts/*/values-$env.yaml" >/dev/null && return 0
  for app in "${MOBILE_UNITS[@]}"; do
    mobile_channel "$app" "$stage" >/dev/null && return 0
  done
  return 1
}

stages_available() { # one stage per line, in order
  local s
  for s in "${RELEASE_STAGES[@]}"; do stage_has_env "$s" && printf '%s\n' "$s"; done
  return 0
}

# stage_first_available <stage> → <stage> itself when it has an environment, otherwise the next stage
# that has one (ga at the latest)
stage_first_available() {
  local i
  i="$(stage_index "$1")" || return 1
  for (( ; i < ${#RELEASE_STAGES[@]}; i++ )); do
    stage_has_env "${RELEASE_STAGES[$i]}" && { printf '%s\n' "${RELEASE_STAGES[$i]}"; return 0; }
  done
  return 1
}

# stage_version <version> <stage> → the version a unit enters <stage> with, computed by the semver
# package (a devDependency): inc(<version>, 'prerelease', <stage>, '1'), so 1.2.0-alpha.3 → 1.2.0-beta.1.
# The strict pattern runs first because semver also accepts a leading "v".
stage_version() {
  local v="$1" id="$2" bin="$REPO_ROOT/node_modules/.bin/semver"
  [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || return 1
  [[ -x "$bin" ]] || { echo "找不到 ${bin}，先在 $REPO_ROOT 執行 pnpm install" >&2; return 1; }
  "$bin" -i prerelease --preid "$id" -n 1 "$v"
}

# version_stage <version> → the stage a released unit version belongs to: ga for X.Y.Z, <stage> for
# X.Y.Z-<stage>.N with <stage> one of alpha, beta, rc. Any other shape fails, because publishing and
# store uploads derive their dist-tag and build number from the stage and must not guess one.
version_stage() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]] || return 1
  printf '%s\n' "${BASH_REMATCH[2]:-ga}"
}

# prerelease-type the config carries in <stage>. release-please appends it verbatim when a unit with a
# stable version takes its first change (1.3.1 + feat → 1.4.0-alpha.1) and afterwards only bumps the
# trailing number, so "<stage>.1" makes every stage start at .1 without pinning a version.
stage_prerelease_type() { printf '%s\n' "$1.1"; }

# train_stage [<config file>] → the stage the train's config declares: the prerelease-type without its
# number while in prerelease mode, ga otherwise
train_stage() {
  local cfg="${1:-$CONFIG}" type
  if [[ "$(jq -r '.prerelease // false' "$cfg")" != true ]]; then printf '%s\n' ga; return 0; fi
  type="$(jq -r '."prerelease-type" // empty' "$cfg")"
  type="${type%%.*}"
  if ! is_stage "$type" || [[ "$type" == ga ]]; then
    die "$cfg 的 prerelease-type 是「${type}」，不是 ${RELEASE_STAGES[*]:0:3} 之一，無法判斷發布分支所在階段"
  fi
  printf '%s\n' "$type"
}

# train_commits_not_on_main <rev> [-- <pathspec>...] → "<short sha> <subject>" for each commit the train
# made after it was opened (the newest commit carrying a Release-Train-Base trailer) that origin/main
# does not have yet. A commit counts as on main when main has a patch-equivalent commit, or when it was
# cherry-picked ("cherry picked from commit X") from a commit already on main. Merge-back is a squash,
# so ancestry alone cannot answer this: every train commit is off main's history.
train_commits_not_on_main() {
  local rev="$1"; shift
  [[ "${1:-}" == -- ]] && shift
  local open mark sha src
  # No pipe into an early-exiting reader here: under pipefail the writer's SIGPIPE fails the function.
  open="$(git log -1 --format=%H -E --grep='^Release-Train-Base: [0-9a-f]{7,40}$' "$rev")"
  [[ -n "$open" ]] || return 0
  while read -r mark sha; do
    [[ "$mark" == + ]] || continue
    (( $# == 0 )) || [[ -n "$(git diff-tree --no-commit-id --name-only -r "$sha" -- "$@")" ]] || continue
    src="$(git log -1 --format=%B "$sha" | sed -nE 's/^\(cherry picked from commit ([0-9a-f]{7,40})\)$/\1/p' | tail -1)"
    if [[ -n "$src" ]] && git merge-base --is-ancestor "$src" origin/main 2>/dev/null; then continue; fi
    git log -1 --format='%h %s' "$sha"
  done < <(git cherry origin/main "$rev" "$open")
}

# Bring the local train up to its remote. Fetch even under --dry-run; fetching only updates local refs.
train_sync() { # train_sync <branch>
  local branch="$1"
  git fetch --quiet --tags origin || die "無法從 origin 抓取 tag 與 main，起點閘需要遠端最新的產品 tag"
  # 明確用遠端追蹤 ref：release-please 的工作分支名尾端同樣是 "$branch"，
  # 以短 refname pull 會同時命中兩條而報 "Cannot fast-forward to multiple branches"
  run git merge --ff-only "origin/$branch"
}

# Gates a train passes before it moves to <stage>, run after train_sync. The ci gate is called the
# GA gate when the train goes to ga, which is how the docs know it.
train_gates() { # train_gates <branch> <line> <stage>
  local branch="$1" line="$2" stage="$3" shipped st gate_ok rest tip i gate act ahead
  if [[ "$stage" == ga ]]; then gate="GA 閘" act="跑 GA"; else gate="ci 閘" act="推進到 $stage"; fi
  # Scripts gate: the train must run main's release tooling. A train rebuilt by hand from an old tag
  # carries that tag's scripts, which may predate a gate. cut-release.sh syncs scripts/ from main
  # when it cuts, so only a hand-made or long-lived train trips this.
  # The difference can also run the other way: a hotfix to scripts/ committed on the train only.
  # Syncing from main would wipe that hotfix, so name those commits and send them to main first.
  if ! git diff --quiet origin/main -- scripts; then
    ahead="$(train_commits_not_on_main HEAD -- scripts)"
    [[ -z "$ahead" ]] \
      || die "發布分支有 main 還沒有的腳本修正，先把它們帶回 main 再${act}：把下列 commit cherry-pick 到 main 並合進去，再用 git checkout origin/main -- scripts 同步 ${branch}。直接同步會蓋掉這些修正："$'\n'"$ahead"
    die "發布腳本落後 main：${branch} 的 scripts/ 與 origin/main 不同。先同步再${act}：git checkout origin/main -- scripts，commit 後推上 ${branch}"
  fi
  # Base gate: a line that already shipped takes patches only, and a patch must continue from the
  # line's latest product tag (vX.Y.Z, or product/vX.Y.Z before 0.3). cut-release.sh refuses any other base. Here it catches a train opened
  # by hand from main (merge-back is a squash, so the tag is never main's ancestor) or from an older
  # tag. It cannot reach a train that runs a finalize-release.sh from before this gate existed.
  shipped="$(product_latest_tag "$line")"
  if [[ -n "$shipped" ]]; then
    git merge-base --is-ancestor "${shipped}^{commit}" HEAD \
      || die "起點閘未通過：${branch} 不含產品線 ${line} 最後一個產品 tag ${shipped}。修補發布要從它重建：刪掉這條分支，用 cut-release.sh --line ${line} --from ${shipped} 重切，修正再 cherry-pick 進去"
    info "✓ 起點含 ${shipped}"
  fi
  # ci gate: the ci run of the train's tip (build, unit tests and the assembled-system e2e) must be
  # green. Every push gets a ci run (ci.yml has no path filters; its scope job skips the jobs when the
  # source is unchanged since the last green run, and that run still concludes success), so the gate
  # waits for the run of this exact commit. The last push is usually a Release PR merge, so that run
  # is often still queued or in progress when the stage moves.
  if (( DRY_RUN == 0 )) && [[ "${CI_GATE:-1}" == 1 ]]; then
    tip="$(git rev-parse "origin/$branch")"
    log "${gate}：等待 $branch 最新 commit ${tip:0:7} 的 ci 執行完成"
    gate_ok=0
    for ((i=1; i<=${CI_GATE_TRIES:-40}; i++)); do
      st="$(gh run list --workflow ci.yml --branch "$branch" --commit "$tip" --limit 1 --json status,conclusion,databaseId \
            --jq '.[0] | "\(.status)/\(.conclusion // "")/\(.databaseId)"' 2>/dev/null || true)"
      [[ -z "$st" ]] && { warn "${tip:0:7} 尚無 ci 執行紀錄，等待中"; sleep "${CI_GATE_SLEEP:-15}"; continue; }
      case "$st" in
        completed/success/*) info "✓ ci run ${st##*/} 通過"; gate_ok=1; break ;;
        completed/*) rest="${st#completed/}"; die "${gate}未通過：ci run ${st##*/} 結論為 ${rest%%/*}（查 gh run view ${st##*/}）；修正後重跑，或以 CI_GATE=0 略過" ;;
        *) sleep "${CI_GATE_SLEEP:-15}" ;;
      esac
    done
    (( gate_ok )) || die "${gate}逾時：$branch 最新 commit ${tip:0:7} 的 ci 仍未完成"
  fi
}

# One commit per unit carrying "Release-As: <version>", for every unit of the train that shipped a
# prerelease: <stage> ga strips the suffix (1.2.0-rc.2 → 1.2.0), a prerelease stage restarts at .1
# (1.2.0-alpha.3 → 1.2.0-beta.1). A unit still on a stable version has not released in this train and
# is left alone. Under DRY_RUN it only lists the moves.
train_release_as() { # train_release_as <branch> <stage>
  local branch="$1" stage="$2" u p cur next id
  local -a units=()
  while IFS= read -r u; do [[ -n "$u" ]] && units+=("$u"); done < <(config_units)
  for u in "${units[@]}"; do
    p="$(unit_path "$u")"
    cur="$(manifest_version "$p")"
    [[ "$cur" == *-* ]] || { info "⊘ ${u}（${cur}）本次發布未發過 prerelease，略過"; continue; }
    if [[ "$stage" == ga ]]; then next="$(stable_version "$cur")"; else
      id="${cur#*-}"; id="${id%%.*}"
      if is_stage "$id" && (( $(stage_index "$id") >= $(stage_index "$stage") )); then
        die "${u} 的版號 ${cur} 已在 ${id}，不能再進入 ${stage}"
      fi
      next="$(stage_version "$cur" "$stage")"
    fi
    info "${u}：$cur → $next"
    (( DRY_RUN )) && continue
    release_as_commit "$branch" "$u" "$p" "$next"
  done
}

# release-please 依「commit 觸及哪些路徑」歸屬 Release-As，所以這個 commit 必須觸及本單元路徑；又不能
# 是空的，因為空 commit 會被歸屬到所有路徑（src/manifest.ts 的 CommitSplit includeEmpty: true），一個
# 單元的 Release-As 就會污染其他單元。標記檔為此存在，時間戳讓重跑時仍產生真實 diff。它只活在發布
# 分支上，merge-back 會先刪掉再算差異，不進 main。
# 發布套件時標記檔還在單元目錄裡，所以每個套件單元的打包設定都要讓它不進套件：
#   - npm：package.json 的 files 白名單不列它。
#   - crates.io：Cargo.toml 寫 exclude。有 include 時 cargo 忽略 exclude，改成不把它列進 include。
#   - PyPI：uv_build 只打包模組目錄，不會收進它。換成會收整個目錄的後端（例如 hatchling）時，
#     sdist 要排除它。
# 核對方式：cargo package --list、npm pack --dry-run、解開 uv build 的產物，都不該出現 .release-marker。
release_as_commit() { # release_as_commit <branch> <unit> <path> <version>
  local branch="$1" u="$2" p="$3" v="$4"
  {
    printf '%s\n' "$v"
    printf '%s\n' "#"
    printf '%s\n' "# 由發布腳本在推進階段或 GA 時寫入，用途只有一個：讓帶 Release-As footer 的"
    printf '%s\n' "# commit 觸及本單元路徑且非空。發布結束前會被刪除，不會進入預設分支。"
    printf '%s\n' "# 理由見 docs/decisions/adr/004-release-engine.md 第 6、33 項。"
    printf '%s\n' "# released from $branch at $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } > "$p/.release-marker"
  git add "$p/.release-marker"
  git commit -q -m "chore($branch): $u $v" -m "Release-As: $v"
}
