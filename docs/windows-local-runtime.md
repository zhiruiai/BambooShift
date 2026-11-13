# Windows local runtime

## Current support

The Windows x64 release is a **connection client**: it connects to an existing
BambooShift service. It does not bundle a Windows personal-workspace service,
execute commands on the client computer, or provide native screen and input control.
See [Windows setup](desktop-client.md#windows-x64) for the supported installation flow.

This document records the implementation boundaries required for a native Windows
personal workspace. Partial source adaptations below do not constitute a shipped
Windows personal workspace.
The Rust backend, TypeScript/Pi workers, and shared product API remain the architecture.

## Concrete blockers

| Boundary | Current implementation | Required change |
| --- | --- | --- |
| Backend filesystem | Static assets, deployment ownership, [workspace storage](../server/api/src/workspace/file_storage.rs), [edits and directory listing](../server/api/src/workspace/file_edits.rs) now use the [shared filesystem boundary](../server/api/src/filesystem/mod.rs). Template storage and shared-Bot database inspection still have Unix-only code. | Finish the remaining adapters and validate the complete native Windows backend. |
| Private configuration | Windows files inherit the selected parent directory's ACL. An owner-only configuration/database policy has not been implemented or qualified. | Verify private configuration and database ownership without treating Unix mode bits as Windows access control. |
| Runtime package | [Desktop options](../scripts/desktop/options.mjs), [runtime staging](../scripts/desktop/runtime-package.mjs), and [backend packaging](../scripts/package-backend.mjs) exclude Windows bundled services. | Support native Windows binaries, verified Node archives, and platform-specific native dependencies. |
| Desktop launcher | [Local runtime](../desktop/local-runtime.cjs) assumes POSIX ownership, paths, and process groups. Host-command consent is coupled to the macOS Cua driver. | Separate runtime, shell, and desktop capabilities; implement Windows private storage and lifecycle handling. |
| Command execution | [Host shell](../server/workers/computer-runtime/host-shell.ts) uses `/bin/sh` and POSIX process-group signals. | Add a Windows process supervisor with explicit shell semantics and bounded cancellation. |
| Results and shutdown | [TypeScript result validation](../server/workers/computer-runtime/isolated-shell.ts) and [Rust validation](../server/api/src/computer/validation.rs) restrict exit codes to 0–255. [Local executor](../server/api/src/computer/local_executor.rs) kills descendant groups only on Unix. | Preserve Windows native exit codes and verify process-tree cleanup without inventing POSIX signals. |
| Release qualification | [Windows build](../scripts/publishing/build-windows-client.mjs) and [smoke test](../scripts/check-windows-client.mjs) assert `serviceIncluded: false`. [Publication checks](../scripts/publishing/check-client-release.mjs) reject Windows bundled runtimes. | Qualify a complete Windows package before changing these release gates. |

The [native dependency selector](../scripts/desktop/runtime-dependencies.mjs) also
assumes separate Sharp and libvips packages. Windows package contents must be
inventoried independently, including DLLs and redistribution notices. Existing
macOS candidate evidence does not qualify Windows artifacts.

## Implemented foundation

Static assets open each directory component relative to a retained directory
handle, reject links and Windows reparse points, and retain their 10 MiB read limit.
The configured root's ancestors remain an operator-selected trust boundary; the
root's final component is opened without following links, including paths ending
in a slash or dot. Child names reject traversal, alternate data streams and Windows
device aliases consistently across platforms.

Deployment ownership uses a retained file lock through fs4, with contention
reported separately from other I/O errors. It never deletes or truncates the lock
file. Unix creation retains 0700 directories and a 0600 lock. Windows creation
inherits the parent directory's ACL; this is **not** an implementation of a new
owner-only Windows ACL policy. Private configuration and database access still need
their own complete Windows review.

Handle metadata preserves Unix device/inode/change timestamps and Windows volume
plus the full 128-bit file ID, link count and write/change timestamps. A metadata
stamp detects changes; it is not a content digest or an atomic conditional delete.

Workspace upload, read, delete, text edit and directory listing now reuse this
boundary. Mutation sources must be ordinary single-link files whose current name
matches the retained handle's full identity. Listing excludes internal transaction
files, links and other unsupported entries. The authorization and database
transaction logic remain shared rather than introducing a Windows-specific backend.

On Windows, mutation handles request DELETE access and omit FILE_SHARE_DELETE;
ordinary readers do not request DELETE and retain compatible sharing. Retained
directory handles also prevent directory replacement while an operation is active.
The [mutation adapter](../server/api/src/filesystem/mutation_windows.rs) renames the
held file with `SetFileInformationByHandle`, a relative target name and a retained
target-directory handle. `ReplaceIfExists` remains false, so collisions cannot
overwrite another file. It does not fall back to a path-based overwriting rename.

Windows removal marks the held object for deletion and reports `DeleteOnClose`:
the hidden name may remain until compatible readers close. Edit rollback therefore
first moves the published new file to a fresh transaction name, then restores the
old backup with no-replace semantics. If isolation fails, it preserves the new
contents; if restoration collides, it preserves the other writer's file and the
backup. Final hidden-file cleanup must not be mistaken for immediately freeing a
visible destination name. Unix retains native no-replace rename and an identity
check before unlink; that check and unlink are not an atomic conditional operation.

Workspace writes now match registered records to the retained file's actual
identity, preserving the canonical record and spelling without global case folding.
Every matching voice-memo record remains immutable; duplicate or unverifiable
records cause a conflict before commit. A second identity check after publication
also catches aliases of previously missing files and rolls back conflicting
recreations. These checks read metadata, not file bodies. Real Pi regression tests
use the current volume's actual case behavior; native Windows short-name and
installed-package behavior still need separate runtime qualification.

The foundation at `e50f4df` passed 24 release-mode checks on macOS, including
real HTTP asset routes and cross-process deployment-lock contention and release.
After the workspace and registry changes, the complete library test target plus
`workspace_file_uploads`, `agent_workspace_tools`, `agent_file_delivery` and
`agent_file_aliases` passed in release mode on macOS: **131 passed, zero failed**. Three existing tests requiring live public services or installed system
voices were not run. Coverage includes database rollback, replacement-file
canaries, staging-name collisions, retained readers, large generated downloads
and real Pi file-tool delivery with synthetic model responses.

Isolated offline Windows MSVC `cargo check --tests` also passed with Rust 1.85.1:
first for the foundation, then for the 19 source/test files covering shared
filesystem operations, workspace transactions, registry matching and deployment ownership. The
workspace check uses a narrow private `ApiError` adapter and excludes HTTP,
authorization and database integration. This verifies Windows API types and test
compilation, **not execution**. The full Windows backend, runtime tests and
installed-package flow still require separate qualification.

## Minimal platform boundaries

Keep authorization, approvals, task state, and receipts in Rust. Keep Pi integration,
tool adaptation, and bounded output handling in the existing TypeScript workers.
Only operating-system mechanisms need platform implementations:

- **Private filesystem:** directory handles, private configuration, deployment locks,
  file identity, exclusive creation, and no-replace publication and rollback. Upload/edit transactions
  remain shared. Do not replace handle-relative operations with a path check followed
  by an unrelated open; that introduces a race. Preserve rejection of redirected
  paths and unexpected hard links, including Windows reparse points.
- **Process supervision:** launch, deadline, cancellation, output drain, and confirmed
  descendant cleanup. A Windows Job Object can supervise ordinary child processes;
  it is not a security sandbox for arbitrary hostile code. Create the child suspended,
  assign it before resuming, disable breakaway, and terminate the job on cancellation
  or supervisor loss. A timeout or incomplete cleanup must remain a failed operation.
- **Desktop runtime:** executable locations, a narrow platform environment allowlist,
  startup/shutdown, and independently reported `runtime`, `hostShell`, and
  `hostDesktop` capabilities. Missing screen/input support must not imply that an
  explicitly authorized command runner is unavailable.

These are internal boundaries, not a second business backend or another plugin
system. Existing Cordis engine interfaces and scoped worker protocols remain shared.

## Reuse candidates

The first three components now support the foundation above. Their use does not
qualify the remaining Windows runtime or its installer:

- [Bytecode Alliance cap-std](https://github.com/bytecodealliance/cap-std) and cap-fs-ext,
  both pinned to 4.0.3, provide
  cross-platform directory-relative filesystem operations and an
  [MIT license option](https://github.com/bytecodealliance/cap-std/blob/main/LICENSE-MIT).
  Its default handling permits contained symlinks. The
  [cap-fs-ext no-follow option](https://github.com/bytecodealliance/cap-std/blob/main/cap-fs-ext/src/open_options_follow_ext.rs)
  applies to the final path component; preserving BambooShift's stricter policy
  requires checking each directory component and file identity.
- [fs4](https://github.com/al8n/fs4), pinned to 1.1.0 with only its sync feature,
  offers cross-platform file locks under MIT or
  Apache-2.0, including [Windows LockFileEx](https://github.com/al8n/fs4/blob/main/src/windows.rs).
  It does not replace private-file permissions or path validation.
- [Microsoft windows-rs/windows-sys](https://github.com/microsoft/windows-rs) provides
  [MIT-licensed bindings](https://github.com/microsoft/windows-rs/blob/master/license-mit)
  for Windows APIs. Use the existing Rust layer for
  [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
  and necessary handle/security operations, avoiding another language or Node native addon.
- Reuse the existing Electron packaging and native Windows CI runner. Extend the
  [Node archive verifier](../scripts/desktop/node-runtime.mjs) and
  [binary checks](../scripts/desktop/native-binary.mjs) for official Windows artifacts.

## Delivery sequence and acceptance

1. **Native backend foundation.** Complete the remaining filesystem adapters and run
   a native Windows MSVC build. With synthetic data, verify account-free personal
   workspace startup, model configuration, file create/edit/download, exclusive
   deployment ownership, restart persistence, and lock release after shutdown.
   This is the first useful implementation slice; packaging flags alone are insufficient.
2. **Approved local commands.** Connect the Windows supervisor to the existing
   worker protocol. Verify pending and rejected actions perform no command, approved
   actions return real output, running cancellation leaves no delayed descendant
   writes, and the executor remains reusable. Cover Unicode/space-containing paths,
   native exit codes, deadlines, worker failure, and application shutdown.
3. **Complete package qualification.** Run those checks from the installed package
   without developer tooling, using a fresh profile and synthetic model. Check PE
   architecture, dependency integrity, notices, startup recovery, and privacy. Keep
   connection-client support and publication gates intact until this evidence exists.

Native screen capture and keyboard/mouse control require a separate adapter and
permission review. Successful command execution must not be advertised as desktop
input support. See [computer execution](computer.md) and [architecture](architecture.md).
