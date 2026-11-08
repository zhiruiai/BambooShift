# Rust backend

Rust is the business and authorization backend. Its HTTP handlers own account identity, workspace data, approvals, schedules, receipts and execution orchestration. They do not forward business requests to the previous Node server. The four isolated JavaScript workers supply the Pi SDK, MCP/OAuth transport, computer execution and document codecs; they do not own business SQLite databases.

The crate contains the platform and workspace modules below. Protocol adapters and their tests live under [workers](../workers/). Rust compatibility tests cover persisted data and HTTP contracts.

## Modules and API boundaries

Most workspace routes use `/api/workspaces/:workspaceId`. Account cookies, fixed expected-user checks, current workspace membership and operation-specific owner checks are enforced by Rust. Platform operator sessions are independent; operators can manage users and workspace availability without receiving workspace content access.

| Module                                     | HTTP area and responsibilities                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts, sessions and platform operations | `/api/account/*`, `/api/platform/*`, `/api/invitations/*`: registration, login, profile/password, device sessions, personal/team workspaces, members, invitations, operator setup and administration.                                 |
| Workspace store and settings               | Bootstrap, SSE, Bot profiles, groups and group-plan CAS, durable creation receipts, sidebar preferences, model profiles/private credentials, primary Bot and default time zone.                                                       |
| Files, avatars and knowledge               | Registered files and downloads, bounded image upload/crop through the Rust image worker, local memories and skill lifecycle.                                                                                                          |
| Agent execution                            | Chat submission and duplicate detection, original requester grants, queueing/steering, reactions, cancellation, Pi tool dispatch and bounded child delegation. Rust performs authorized memory, workspace-file and routine mutations. |
| Scheduling and memory import               | Fixed-time-zone routines, scheduled/manual run history, durable operation receipts and closure fences, primary check-ins and constrained personal memory-import execution.                                                            |
| Team building                              | Model-generated plans and chat proposals, draft revisions, selected-Bot catalog review, idempotent confirmation and atomic Bot/group creation.                                                                                        |
| Shared Bots                                | Live source profile/skill references into private personal chats, selected source file/application grants, version checks and active-run revocation. Source secrets and private memory are not copied to the recipient.               |
| Templates and copying                      | Private editable drafts, immutable publications, sharing policy, exact-version import/copy and persistent receipts.                                                                                                                   |
| Apps                                       | MCP connection/catalog lifecycle, OAuth flows and refresh, requester-owned approval, exact approved tool versions and cancellation.                                                                                                   |
| Computer execution                         | Local/remote connection state, screenshots, approved actions, file transfer, takeover, task/screen binding, lifecycle recovery and cloud provisioning. External browser/desktop/VM prerequisites remain explicit.                     |
| Speech                                     | Bounded upload/transcription, access revalidation, process cleanup and capacity control.                                                                                                                                              |
| Web delivery                               | Independent product/operations listeners and `/api/health`; separate `runtimeDir/dist` and `runtimeDir/operations-dist` static trees. Source, private configuration and data are not served.                                          |

The route modules and HTTP contract tests are the authoritative implementation contract. JSON responses preserve the existing client shapes. Errors retain `error` and provide a stable `code`; `Accept-Language: en` requests English errors, while Chinese is the default. Clients must use codes rather than matching message text. API responses are `no-store`.

## Development and validation

Rust 1.85 or newer and Node 22.19 or newer are required. From the repository root:

```sh
npm run backend:build
npm test
# Optional browser fixtures require a compatible installed Chrome.
npm run test:browser
npm run build:web
npm run build:workers
```

The Rust helper uses the workspace build/cache directories and the installed toolchain. Set `OPENBOT_CARGO_OFFLINE=1` after dependencies are cached to prohibit registry access. Tests use temporary databases, synthetic accounts and local protocol/model fixtures. Live deployments and real paid model calls are separate, explicit validations.

## Assemble and verify a service package

```sh
npm run build:web
npm run backend:package -- --out .build/backend-package
# Add --release to build optimized Rust executables for this platform.
cd .build/backend-package/runtime
npm ci --omit=dev --ignore-scripts
cd ../../..
node scripts/check-backend-package.mjs .build/backend-package
```

The packager builds and copies only `openbot-backend` and `openbot-image-worker`, compiles the four execution entries to `.mjs`, copies the separate public `dist` and `operations-dist` trees and adds placeholder deployment documentation. It never copies the migration probe, former Node server, application source, private configuration or user data. It rejects links and unexpected files in the public asset tree, writes into a staging directory and publishes only a complete package. An existing output directory is never overwritten implicitly.

The generated production manifest and lock retain exact SDK versions and integrity hashes from the checked-in root lock. `tsx`, TypeScript and repository source are not production dependencies. An offline `npm ci` requires the matching tarballs in the selected cache. Native optional packages, browser executables and desktop helpers must match the deployment OS and architecture; a macOS package is not a Linux binary distribution.

The package check starts the packaged executable with a fresh private temporary data directory, uses a local synthetic model, exercises registration and real Pi/Rust tool execution, validates receipts/access revocation and then stops the process. See [the package acceptance evidence](../../docs/evidence/backend-package-acceptance.json) for the scope actually validated.

## Private deployment configuration

Use [deployment/server.example.json](deployment/server.example.json) as a placeholder template and [the deployment guide](deployment/README.md) for startup and lifecycle commands. Configuration must be a regular owner-only file (`chmod 600`). Explicit absolute `runtimeDir` and `nodeBinary` paths select the published runtime and Node executable. Keep `dataDir` separate from the package. Real addresses, account credentials and API keys belong in private configuration or the service's private credential storage, never examples or source.

The service binds only to loopback. Remote deployment requires an HTTPS reverse proxy and an exact `publicOrigin`; it is not inferred from an untrusted forwarded host. The one-time `--init-operator` flag writes a private setup-code file only when explicitly requested. Operator pages `/admin/setup`, `/admin/login` and `/admin` belong to the separate operations listener configured by `operations.bind`, `operations.publicOrigin` and `operations.webOrigin`. Product login/registration use `/login` and `/register`, with account settings at `/account`. Product and operations mount different API groups and use separate session purposes; the two listeners share a single State and scheduler.

`SIGTERM` closes admission, cancels execution, waits for owned process cleanup and closes streams/databases. Persistent uncertain requests are read through receipts; restarting does not authorize replay. Back up existing data and stop the former writer before an explicit cutover. Compatibility tests preserve the identity schema, `scrypt-v1` password hashes, cookie conventions and workspace records; their passing does not replace a deployment-specific backup and migration verification.
