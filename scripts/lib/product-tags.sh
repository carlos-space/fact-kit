#!/usr/bin/env bash
# Product tags of the repository. Source it; do not execute.
# A product tag is vX.Y.Z. A unit tag is <component>/vX.Y.Z and never matches, because the glob "v[0-9]*" has no "/".

# product_tag <version> → the tag a product release gets
product_tag() { printf '%s\n' "v$1"; }

# product_tags → every product tag, newest version first, one per line. Only vX.Y.Z counts: a tag with a
# suffix is not a product release.
product_tags() {
  git tag --list 'v[0-9]*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1nr -k2,2nr -k3,3nr
  return 0
}

# product_latest_tag <line> → the tag of the newest patch of the product line X.Y, or nothing
product_latest_tag() {
  local t
  while IFS= read -r t; do
    [[ "${t#v}" == "$1".* ]] && { printf '%s\n' "$t"; return 0; }
  done < <(product_tags)
  return 0
}
