#!/usr/bin/env bash
set -euo pipefail

[[ "$RELEASE_TAG" == "v$RELEASE_VERSION" && "$RELEASE_TAG" =~ ^v0\.0\.[1-9][0-9]{0,6}$ ]]
[[ "$RELEASE_SOURCE" =~ ^[a-f0-9]{40}$ && "$RELEASE_DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]
test "$(git rev-parse HEAD)" = "$RELEASE_SOURCE"

builds="$RUNNER_TEMP/pandamate-builds"
source_name="PandaMate-$RELEASE_TAG-source.tar.gz"
server_name="PandaMate-$RELEASE_TAG-server-linux-x64.tar.gz"
client_name="PandaMate-$RELEASE_TAG-client-macos-arm64.zip"
publish_dir="$(mktemp -d "$RUNNER_TEMP/pandamate-publish.XXXXXX")"
for file in "$source_name" "$server_name"; do
  test -s "$builds/pandamate-linux-x64/$file"
  cp "$builds/pandamate-linux-x64/$file" "$publish_dir/"
done
test -s "$builds/pandamate-macos-arm64/$client_name"
cp "$builds/pandamate-macos-arm64/$client_name" "$publish_dir/"

node scripts/publishing/stamp-version.mjs "$RELEASE_VERSION"
git add -u
tree="$(git write-tree)"
for platform in linux-x64 macos-arm64; do
  test "$(cat "$builds/pandamate-$platform/source-tree.txt")" = "$tree"
done

tag_ref="refs/tags/$RELEASE_TAG"
if git show-ref --verify --quiet "$tag_ref"; then
  test "$(git cat-file -t "$tag_ref")" = tag
  test "$(git for-each-ref --format='%(subject)' "$tag_ref")" = "PandaMate release from $RELEASE_SOURCE"
  test "$(git rev-parse "$tag_ref^{tree}")" = "$tree"
  tagged="$(git rev-parse "$tag_ref^{commit}")"
  if [[ "$tagged" != "$RELEASE_SOURCE" ]]; then
    test "$(git rev-parse "$tagged^")" = "$RELEASE_SOURCE"
  fi
else
  git config user.name 'PandaMate Release'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  if [[ "$tree" != "$(git rev-parse HEAD^{tree})" ]]; then
    git commit -m "Prepare PandaMate $RELEASE_TAG"
  fi
  git tag -a "$RELEASE_TAG" -m "PandaMate release from $RELEASE_SOURCE"
  git push origin "$tag_ref:$tag_ref"
fi

(cd "$publish_dir" && sha256sum "$source_name" "$server_name" "$client_name" > SHA256SUMS.txt)

releases="$publish_dir/releases.json"
gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100" > "$releases"
release_count="$(jq -r --arg tag "$RELEASE_TAG" '[.[][] | select(.tag_name == $tag)] | length' "$releases")"
if [[ "$release_count" == 0 ]]; then
  notes="$publish_dir/notes.md"
  cat > "$notes" <<NOTES
<!-- pandamate-source: $RELEASE_SOURCE -->

PandaMate $RELEASE_TAG · $RELEASE_DAY

- **Source** includes the web, server, desktop, and Flutter source with the release version.
- **Linux x64 server** includes the product web app, operations console, and worker bundles. Read the README in the archive for setup.
- **macOS Apple Silicon client** connects to a separate PandaMate server. The app uses a local ad-hoc signature and has no Apple notarization.
- **SHA256SUMS.txt** lists the checksums for the three archives.

源码包包含各端源码。Linux x64 服务包包含网页和运营控制台。macOS Apple Silicon 客户端需连接单独运行的服务，采用临时签名，未经过 Apple 公证。
NOTES
  gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --verify-tag --draft \
    --title "PandaMate $RELEASE_TAG" --notes-file "$notes"
fi

gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100" > "$releases"
release="$(jq -ec --arg tag "$RELEASE_TAG" --arg marker "<!-- pandamate-source: $RELEASE_SOURCE -->" \
  '[.[][] | select(.tag_name == $tag)] | select(length == 1) | .[0] | select(.body | contains($marker))' "$releases")"
id="$(jq -er '.id | numbers' <<< "$release")"
draft="$(jq -r '.draft' <<< "$release")"
files=("$source_name" "$server_name" "$client_name" SHA256SUMS.txt)
asset_list="$publish_dir/remote-assets.json"

refresh_assets() {
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases/$id/assets?per_page=100" > "$asset_list"
}

verify_assets() {
  refresh_assets
  test "$(jq '[.[][]] | length' "$asset_list")" = "${#files[@]}"
  for file in "${files[@]}"; do
    hash="$(sha256sum "$publish_dir/$file" | cut -d ' ' -f 1)"
    jq -e --arg name "$file" --arg digest "sha256:$hash" \
      '[.[][] | select(.name == $name and .state == "uploaded" and .digest == $digest)] | length == 1' \
      "$asset_list" > /dev/null
  done
}

if [[ "$draft" == true ]]; then
  refresh_assets
  allowed="$(printf '%s\n' "${files[@]}" | jq -R . | jq -s .)"
  jq -e --argjson allowed "$allowed" \
    'all(.[][]; .name as $name | $allowed | index($name) != null)' "$asset_list" > /dev/null
  gh release upload "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --clobber \
    "$publish_dir/$source_name" "$publish_dir/$server_name" "$publish_dir/$client_name" \
    "$publish_dir/SHA256SUMS.txt"
  verify_assets
  gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false --latest
else
  verify_assets
fi
gh api "repos/$GITHUB_REPOSITORY/releases/$id" | \
  jq -er --arg tag "$RELEASE_TAG" 'select(.draft == false and .tag_name == $tag) | .html_url'
