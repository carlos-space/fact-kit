#!/usr/bin/env bash
# Product tags of the repository. Source it; do not execute.
# From the version after 0.2.0 on, a product tag is vX.Y.Z. The tags product/v0.1.0 and product/v0.2.0 were made
# before that and stay as they are, so every reader of product tags goes through the functions below and sees both
# shapes. A unit tag is <component>/vX.Y.Z and never matches either shape, because the glob "v[0-9]*" has no "/".

PRODUCT_TAG_PREFIX="v"

# product_tag <version> → the tag a new product release gets
product_tag() { printf '%s\n' "${PRODUCT_TAG_PREFIX}$1"; }

# product_tag_version <tag> → X.Y.Z of vX.Y.Z or product/vX.Y.Z
product_tag_version() { local v="${1#product/}"; printf '%s\n' "${v#v}"; }

# product_tags → every product tag, newest version first, one per line. Only X.Y.Z counts: a tag with a
# suffix is not a product release.
product_tags() {
  local t v
  git tag --list 'v[0-9]*' 'product/v[0-9]*' | while IFS= read -r t; do
    v="$(product_tag_version "$t")"
    [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && printf '%s %s\n' "$v" "$t"
  done | sort -t. -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f2
  return 0
}

# product_tag_for <version> → the existing tag of that product version, in either shape; fails when none
product_tag_for() {
  local t
  while IFS= read -r t; do
    [[ "$(product_tag_version "$t")" == "$1" ]] && { printf '%s\n' "$t"; return 0; }
  done < <(product_tags)
  return 1
}

# product_latest_tag <line> → the tag of the newest patch of the product line X.Y, or nothing
product_latest_tag() {
  local t
  while IFS= read -r t; do
    [[ "$(product_tag_version "$t")" == "$1".* ]] && { printf '%s\n' "$t"; return 0; }
  done < <(product_tags)
  return 0
}
