# The git tag release-please gives a unit at a version, read from release-please-config.json.
#   jq -r --arg p <package path> --arg v <version> -f scripts/lib/unit-tag.jq release-please-config.json
# A unit-level setting wins over the top-level one, as in release-please. The defaults are release-please's
# own: component in the tag, a "v" before the version, "-" between them. This repository's config sets the
# separator to "/" at the top level. The Swift unit sets include-component-in-tag and include-v-in-tag to
# false, so its tag is the bare version. A setting that is false must win, so presence is tested with has()
# and never with //, which treats false as missing.
# A path the config does not list is an error, not a guess: on a release branch the config holds only the
# train's units, and a tag made up for another unit would name a tag release-please never creates.
. as $c
| (.packages[$p] // error("\($p) is not a package of release-please-config.json")) as $u
| def pick($k; $d): if ($u | has($k)) then $u[$k] elif ($c | has($k)) then $c[$k] else $d end;
  pick("include-component-in-tag"; true) as $withComponent
  | pick("include-v-in-tag"; true) as $withV
  | pick("tag-separator"; "-") as $sep
  | (if $withV then "v" else "" end) as $v0
  | if $withComponent and ($u.component // "") != ""
    then "\($u.component)\($sep)\($v0)\($v)"
    else "\($v0)\($v)" end
