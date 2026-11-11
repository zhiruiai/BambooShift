#!/usr/bin/env bash
set -euo pipefail

[[ "$RELEASE_TAG" == "v$RELEASE_VERSION" && "$RELEASE_TAG" =~ ^v0\.0\.[1-9][0-9]{0,6}$ ]]
[[ "$RELEASE_SOURCE" =~ ^[a-f0-9]{40}$ && "$RELEASE_DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]
test "$(git rev-parse HEAD)" = "$RELEASE_SOURCE"
[[ "$RELEASE_BRAND" =~ ^(BambooShift|MosoCrew|PandaMate)$ ]]
[[ "$RELEASE_PACKAGE_NAME" =~ ^(BambooShift|MosoCrew|PandaMate)$ ]]
release_brand="$RELEASE_BRAND"

builds="$RUNNER_TEMP/pandamate-builds"
source_name="$RELEASE_PACKAGE_NAME-$RELEASE_TAG-source.tar.gz"
server_name="$RELEASE_PACKAGE_NAME-$RELEASE_TAG-server-linux-x64.tar.gz"
mac_name="$RELEASE_PACKAGE_NAME-$RELEASE_TAG-client-macos-arm64.zip"
windows_name="$RELEASE_PACKAGE_NAME-$RELEASE_TAG-client-windows-x64.zip"
publish_dir="$(mktemp -d "$RUNNER_TEMP/pandamate-publish.XXXXXX")"
files=("$source_name" "$server_name" "$mac_name")
platforms=(linux-x64 macos-arm64)
windows_notes_en=""
windows_notes_zh=""
for file in "$source_name" "$server_name"; do
  test -s "$builds/bambooshift-linux-x64/$file"
  cp "$builds/bambooshift-linux-x64/$file" "$publish_dir/"
done
test -s "$builds/bambooshift-macos-arm64/$mac_name"
cp "$builds/bambooshift-macos-arm64/$mac_name" "$publish_dir/"
if [[ -f scripts/publishing/build-windows-client.mjs ]]; then
  test -s "$builds/bambooshift-windows-x64/$windows_name"
  cp "$builds/bambooshift-windows-x64/$windows_name" "$publish_dir/"
  files+=("$windows_name")
  platforms+=(windows-x64)
  windows_notes_en="- **Windows x64 client** is an unsigned portable ZIP. Extract the entire folder, run $RELEASE_PACKAGE_NAME.exe, and enter the address of a running $RELEASE_BRAND server."
  windows_notes_zh=" Windows x64 客户端为未签名的便携 ZIP，完整解压后运行 $RELEASE_PACKAGE_NAME.exe，再连接已运行的 $RELEASE_BRAND 服务。"
fi

node scripts/publishing/stamp-version.mjs "$RELEASE_VERSION"
git add -u
tree="$(git write-tree)"
for platform in "${platforms[@]}"; do
  test "$(cat "$builds/bambooshift-$platform/source-tree.txt")" = "$tree"
done

tag_ref="refs/tags/$RELEASE_TAG"
if git show-ref --verify --quiet "$tag_ref"; then
  test "$(git cat-file -t "$tag_ref")" = tag
  subject="$(git for-each-ref --format='%(subject)' "$tag_ref")"
  case "$subject" in
    "BambooShift release from $RELEASE_SOURCE"|"MosoCrew release from $RELEASE_SOURCE"|"PandaMate release from $RELEASE_SOURCE")
      release_brand="${subject%% release from *}" ;;
    *) exit 1 ;;
  esac
  tagged="$(git rev-parse "$tag_ref^{commit}")"
  if [[ "$tagged" != "$RELEASE_SOURCE" ]]; then
    # Older drafts may have tagged a child commit containing the stamped files.
    test "$(git show --no-patch --format=%P "$tagged")" = "$RELEASE_SOURCE"
    test "$(git rev-parse "$tagged^{tree}")" = "$tree"
  fi
else
  git config user.name "$release_brand Release"
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  # Push a tag to the published source commit. The stamped tree is only used for archives.
  git tag -a "$RELEASE_TAG" "$RELEASE_SOURCE" -m "$release_brand release from $RELEASE_SOURCE"
  git push origin "$tag_ref:$tag_ref"
fi

(cd "$publish_dir" && sha256sum "${files[@]}" > SHA256SUMS.txt)
files+=(SHA256SUMS.txt)

releases="$publish_dir/releases.json"
title="$release_brand $RELEASE_TAG"
draft_titles="$(jq -nc --arg tag "$RELEASE_TAG" \
  '["BambooShift", "MosoCrew", "PandaMate"] | map(. + " " + $tag)')"
marker="<!-- pandamate-source: $RELEASE_SOURCE -->"
gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100" > "$releases"
matches="$(jq -c --arg tag "$RELEASE_TAG" --argjson titles "$draft_titles" \
  '[.[][] | .name as $name | select(.tag_name == $tag or (.draft and ($titles | index($name) != null)))]' "$releases")"
release_count="$(jq 'length' <<< "$matches")"
if [[ "$release_count" == 0 ]]; then
  notes="$publish_dir/notes.md"
  cat > "$notes" <<NOTES
<!-- pandamate-source: $RELEASE_SOURCE -->

$release_brand $RELEASE_TAG · $RELEASE_DAY

- **$RELEASE_PACKAGE_NAME source archive** includes the web, server, desktop, and Flutter source with the release version. GitHub’s automatic Source code links contain the original tagged commit.
- **Linux x64 server** includes the product web app, operations console, and worker bundles. Read the README in the archive for setup.
- **macOS Apple Silicon client** connects to a separate $RELEASE_BRAND server. The app uses a local ad-hoc signature and has no Apple notarization.
$windows_notes_en
- **SHA256SUMS.txt** lists the checksums for the archives.

$RELEASE_PACKAGE_NAME 源码包包含带发布版本号的各端源码。GitHub 自动生成的 Source code 下载项对应原始提交。Linux x64 服务包包含网页和运营控制台。macOS Apple Silicon 客户端需连接单独运行的服务，采用临时签名，未经过 Apple 公证。$windows_notes_zh
NOTES
  release="$(gh api --method POST "repos/$GITHUB_REPOSITORY/releases" \
    -f "tag_name=$RELEASE_TAG" -f "name=$title" -F "body=@$notes" -F draft=true -F prerelease=false)"
else
  test "$release_count" = 1
  release="$(jq -c '.[0]' <<< "$matches")"
fi

jq -e --arg tag "$RELEASE_TAG" --argjson titles "$draft_titles" --arg marker "$marker" \
  '.name as $name | (.tag_name == $tag or (.draft and ($titles | index($name) != null))) and (.body | contains($marker))' \
  <<< "$release" > /dev/null
id="$(jq -er '.id | numbers' <<< "$release")"
draft="$(jq -r '.draft' <<< "$release")"
asset_list="$publish_dir/remote-assets.json"

refresh_assets() {
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases/$id/assets?per_page=100" > "$asset_list"
}

hash_file() {
  sha256sum "$publish_dir/$1" | cut -d ' ' -f 1
}

verify_assets() {
  refresh_assets
  test "$(jq '[.[][]] | length' "$asset_list")" = "${#files[@]}"
  for file in "${files[@]}"; do
    jq -e --arg name "$file" --arg digest "sha256:$(hash_file "$file")" \
      '[.[][] | select(.name == $name and .state == "uploaded" and .digest == $digest)] | length == 1' \
      "$asset_list" > /dev/null
  done
}

if [[ "$draft" == true ]]; then
  refresh_assets
  allowed="$(printf '%s\n' "${files[@]}" | jq -R . | jq -s .)"
  jq -e --argjson allowed "$allowed" \
    'all(.[][]; .name as $name | $allowed | index($name) != null)' "$asset_list" > /dev/null
  for file in "${files[@]}"; do
    asset="$(jq -c --arg name "$file" '[.[][] | select(.name == $name)] | .[0] // null' "$asset_list")"
    if [[ "$asset" != null ]]; then
      if jq -e --arg digest "sha256:$(hash_file "$file")" \
        '.state == "uploaded" and .digest == $digest' <<< "$asset" > /dev/null; then
        continue
      fi
      asset_id="$(jq -er '.id | numbers' <<< "$asset")"
      gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id"
    fi
    curl --silent --show-error --fail --max-time 180 \
      --header "Authorization: Bearer $GH_TOKEN" --header 'Content-Type: application/octet-stream' \
      --data-binary "@$publish_dir/$file" \
      "https://uploads.github.com/repos/$GITHUB_REPOSITORY/releases/$id/assets?name=$file" > /dev/null
  done
  verify_assets
  gh api --method PATCH "repos/$GITHUB_REPOSITORY/releases/$id" \
    -f "tag_name=$RELEASE_TAG" -F draft=false -f make_latest=true > /dev/null
else
  verify_assets
fi
gh api "repos/$GITHUB_REPOSITORY/releases/$id" | \
  jq -er --arg tag "$RELEASE_TAG" 'select(.draft == false and .tag_name == $tag) | .html_url'
