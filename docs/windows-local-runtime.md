# Windows local runtime

## Current support

The Windows x64 release is a **connection client**: it connects to an existing
BambooShift service. It does not bundle a Windows personal-workspace service,
execute commands on the client computer, or provide native screen and input control.
See [Windows setup](desktop-client.md#windows-x64) for the supported installation flow.

This document records the implementation boundaries required for a native Windows
personal workspace. The stages below are proposed work, not shipped capabilities.
The Rust backend, TypeScript/Pi workers, and shared product API remain the architecture.

## Concrete blockers

| Boundary | Current implementation | Required change |
| --- | --- | --- |
| Backend filesystem | [Static files](../server/api/src/web.rs), [deployment lock](../server/api/src/deployment_lock.rs), [workspace storage](../server/api/src/workspace/file_storage.rs), and [edits](../server/api/src/workspace/file_edits.rs) unconditionally use Unix file descriptors and system calls. | Make these backend modules compile and preserve their security guarantees on Windows. |
| Runtime package | [Desktop options](../scripts/desktop/options.mjs), [runtime staging](../scripts/desktop/runtime-package.mjs), and [backend packaging](../scripts/package-backend.mjs) exclude Windows bundled services. | Support native Windows binaries, verified Node archives, and platform-specific native dependencies. |
| Desktop launcher | [Local runtime](../desktop/local-runtime.cjs) assumes POSIX ownership, paths, and process groups. Host-command consent is coupled to the macOS Cua driver. | Separate runtime, shell, and desktop capabilities; implement Windows private storage and lifecycle handling. |
| Command execution | [Host shell](../server/workers/computer-runtime/host-shell.ts) uses `/bin/sh` and POSIX process-group signals. | Add a Windows process supervisor with explicit shell semantics and bounded cancellation. |
| Results and shutdown | [TypeScript result validation](../server/workers/computer-runtime/isolated-shell.ts) and [Rust validation](../server/api/src/computer/validation.rs) restrict exit codes to 0–255. [Local executor](../server/api/src/computer/local_executor.rs) kills descendant groups only on Unix. | Preserve Windows native exit codes and verify process-tree cleanup without inventing POSIX signals. |
| Release qualification | [Windows build](../scripts/publishing/build-windows-client.mjs) and [smoke test](../scripts/check-windows-client.mjs) assert `serviceIncluded: false`. [Publication checks](../scripts/publishing/check-client-release.mjs) reject Windows bundled runtimes. | Qualify a complete Windows package before changing these release gates. |

The [native dependency selector](../scripts/desktop/runtime-dependencies.mjs) also
assumes separate Sharp and libvips packages. Windows package contents must be
inventoried independently, including DLLs and redistribution notices. Existing
macOS candidate evidence does not qualify Windows artifacts.

## Minimal platform boundaries

Keep authorization, approvals, task state, and receipts in Rust. Keep Pi integration,
tool adaptation, and bounded output handling in the existing TypeScript workers.
Only operating-system mechanisms need platform implementations:

- **Private filesystem:** directory handles, private configuration, deployment locks,
  file identity, exclusive creation, and atomic replacement. Upload/edit transactions
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

These components are implementation candidates; listing them does not mean they
have been integrated or qualified:

- [Bytecode Alliance cap-std](https://github.com/bytecodealliance/cap-std) provides
  cross-platform directory-relative filesystem operations and an
  [MIT license option](https://github.com/bytecodealliance/cap-std/blob/main/LICENSE-MIT).
  Its default handling permits contained symlinks. The
  [cap-fs-ext no-follow option](https://github.com/bytecodealliance/cap-std/blob/main/cap-fs-ext/src/open_options_follow_ext.rs)
  applies to the final path component; preserving BambooShift's stricter policy
  requires checking each directory component and file identity.
- [fs4](https://github.com/al8n/fs4) offers cross-platform file locks under MIT or
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

1. **Native backend foundation.** Introduce the private filesystem boundary and run
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
