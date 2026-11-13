# Clean native image-codec candidates

The **Native image codecs candidate** GitHub Actions workflow is a manually
triggered qualification job. It does not create a release, alter the reviewed
local candidate, or authorize a bundled desktop runtime for distribution.
Its repository permission is `contents: read`.

## Toolchain and public inputs

The `github-macos-15-xcode-26.3` profile selects the native Apple Silicon
`macos-15` runner and Xcode **26.3, build 17C529**, with macOS SDK **26.2**.
It checks the selected compiler and SDK belong to that Xcode installation,
checks the C and C++ compiler versions agree, and records their version without
machine paths. Python **3.14.10**, Node **24.22.3** and `pkg-config` **3.0.10**
are checked, together with the three hash-pinned build wheels in
`legal/third-party/sharp-libvips-1.3.4/BUILD-TOOLS.txt`.

The profile was selected from the [official macOS 15 arm64 runner inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-arm64-Readme.md).
The runner image itself is rolling: removal or changes to the checked tools
stop the job. Updating a profile requires reviewing the installed versions and
qualifying a new candidate; there is no skip-verification option. The original
local CLT profile remains separate and does not claim the same binary identity.

All library sources, upstream build files and patches come from the public URLs
and exact sizes/SHA-256 digests in `SOURCE-INPUTS-CANDIDATE.json`. Compilation
reads the verified source cache. No private developer directory, personal
configuration, model credential or prebuilt local candidate is required.

## Qualification and retained evidence

1. Install the lockfile dependencies and isolated build tools. Run source,
   privacy, source-archive and native-distribution tests.
2. Compile into a new directory. Package complete license texts, a fresh binary
   archive, and all corresponding source inputs and rebuilding helpers.
3. Verify both archives and every required source/notice against their fresh
   distribution manifest. This observed manifest digest identifies a new
   candidate; it is not the independent review pin used by desktop staging.
4. Install an isolated runtime from the exact projected npm lock, preserve the
   native Sharp addon, replace only its library/version links with the custom
   codec location, and verify the actually loaded library hash. SVG raster
   decoding must be disabled. Run the existing 27-check production image
   contract against that runtime; development fixtures still use original Sharp.
5. Only a successful job uploads five files: the two archives,
   `distribution.json`, `CANDIDATE-CI.json` and `SHA256SUMS`. The candidate record
   binds the source commit, toolchain, exact addon/library/lock hashes and test
   result. Build logs, installed dependencies, environment dumps and temporary
   runtime directories are excluded. Artifacts expire after 14 days.

The archive scan rejects exact build/home paths and personal account names.
Common system-account words (`runner`, `ubuntu`, `root`) may appear in public
source text; their complete home/build paths are still rejected. The repository
privacy check separately scans the source before compilation.

The binary and corresponding-source archive are kept together. Source packages
contain the original license terms, modified source patches and reproducible
commands; repository MIT terms do not replace third-party licenses. Packaging
uses an ad-hoc signature, not Developer ID signing or notarization.

## What a successful run does not establish

`releaseApproval` remains **false** throughout. The existing publisher and
desktop staging checks remain in force. The result still needs independent
manifest review, complete desktop acceptance, user-replacement/re-sign testing,
and a deliberate distribution decision. It does not qualify Windows, Linux or
macOS x64, nor promise byte-identical output across different Apple SDKs.

Run the workflow from a reviewed commit using **Actions → Native image codecs
candidate → Run workflow**. Download the complete artifact to inspect its
manifest and source package. No GitHub-hosted build is claimed successful until
that run actually finishes and its qualification artifact exists.
