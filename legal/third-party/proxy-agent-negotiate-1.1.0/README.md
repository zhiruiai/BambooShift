# proxy-agent-negotiate 1.1.0 source notice

The published package declares MIT but omits its license file. This supplement
preserves the unchanged MIT notice from the implementation's actual source
package, `http-proxy-agent`, rather than inferring a repository-wide license.

Upstream commit `f6335213978d7b7da610cb8f768596bf40929605` extracted the three
public types and the entire `createNegotiateAuth` function from
`packages/http-proxy-agent/src/index.ts` at parent
`2eaa14fccd3ffeb345674468f2d432d3426cca47`. Only the type-only import and the
function's export qualifier changed. All 59 lines of the extracted source are
unchanged in the published version's commit
`b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16`. Transpiling that verified source
reproduces the published executable; source maps do not contain additional code.

The retained `LICENSE` is byte-identical in the originating source package and
the publication commit. `SOURCES.json` records immutable upstream locations,
source hashes, publication integrity, code coverage and the verification method.
The npm provenance statement was inspected as publication evidence; its signature
was not independently verified. The downloaded source git blob and npm tarball
integrity were checked separately.

The supplement manifest binds these bytes to this exact npm package version.
It does not change the source license, create a new copyright statement, or claim
that upstream has published a separate notice for the extracted package. The
upstream packaging omission is tracked in
[proxy-agents issue 479](https://github.com/TooTallNate/proxy-agents/issues/479).
