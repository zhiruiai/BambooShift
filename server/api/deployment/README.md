# OpenBot service package

This package contains the Rust business server, its isolated image worker, two separately built web applications, and four JavaScript execution bundles. It contains no previous Node business server, source configuration, database, account, setup code, or model credential. The package manifest records the platform, build profile and SHA-256 digest of each shipped file. A debug package is suitable for local acceptance; build with `--release` for an optimized deployment on the same OS and architecture.

## Install and configure

Provide Node 22.19 or newer. Install the exact execution SDK dependencies in the runtime directory:

```sh
cd runtime
npm ci --omit=dev --ignore-scripts
cd ..
```

An offline installation additionally requires the package tarballs in the chosen npm cache. Do not regenerate the lockfile or replace an integrity check with an unpinned download. The standard installation uses optional native packages supplied by the locked dependency graph. Browser executables, Linux desktop services, and the macOS native desktop helper are separate prerequisites for those optional computer capabilities; package assembly does not install or activate them.

Copy `deployment/server.example.json` to a private file outside this package. Replace the placeholder absolute paths and origin. For local HTTP development use `publicOrigin: null`; remote access requires an exact HTTPS origin and a reverse proxy to the loopback listener. `runtimeDir` points to this package's `runtime` directory; `nodeBinary` points to the selected executable. Keep `dataDir` outside the package so replacing the application does not replace user data.

```sh
chmod 600 /ABSOLUTE/PATH/TO/server.private.json
./openbot-backend --config /ABSOLUTE/PATH/TO/server.private.json
```

The product listener hosts product APIs and `runtime/dist`. The optional `operations` configuration supplies a separate loopback `bind`, exact `publicOrigin` and development `webOrigin`; that listener hosts only platform APIs and `runtime/operations-dist`. Configure separate HTTPS virtual hosts and proxy each to its own listener. Do not expose the operations listener through the public product proxy. Both listeners share one Rust process, identity store, authorization implementation and scheduler. Start one server for a data directory.

The server prints a structured `openbot:ready` event after binding both configured listeners. `address` identifies the product listener; `operationsAddress` identifies the operations listener when enabled. Each `/api/health` reports the Rust service; it does not claim that external models or computer connections are ready.

## Operator access and lifecycle

On the first explicitly authorized setup only, add `--init-operator`. The setup code is stored in a private file under `dataDir` and is never included in this package. On the operations origin, use `/admin/setup` to complete operator setup, `/admin/login` for operator login and `/admin` for administration. This application has no customer registration or personal/team workspace pages. Operators manage all users and workspace availability through independent operator sessions; an operator cookie does not grant access to a user's private workspace content. Ordinary registration and login use `/register` and `/login` on the product origin; `/account` contains account settings.

The product listener does not mount `/api/platform`, and the operations listener does not mount product account or workspace execution APIs. Old product `/admin` links redirect only to the explicitly configured operations origin; without that configuration they return 404. Operations login is restricted to active platform administrators; registering a personal account or creating a team never grants that role.

Keep deployment configuration, model credentials, OAuth grants, database backups and browser profiles private. Do not run the former Node business server and this server against the same writable data directory. Back up data before an explicit cutover. Package creation alone does not change the currently running service or migrate an existing deployment.

Send `SIGTERM` for graceful shutdown. The server closes admission, cancels active execution, waits for owned child cleanup and closes databases. An external service manager should allow that cleanup to complete. Persistent uncertain requests are recovered through their receipts; shutdown or restart does not authorize replaying model work.

## Execution boundary

Rust owns account and workspace authorization, SQLite state, queueing, schedules, receipts, approvals and secrets. It sends only the permitted operation and required credentials through a private child protocol. The Pi SDK performs inference and asks Rust to execute tools. MCP handles protocol/OAuth transport; computer execution handles approved browser/desktop operations; document execution decodes authorized bytes. These are `.mjs` bundles with exact production dependencies. Production does not require `tsx`, a TypeScript source tree or the previous business server.

Public web research for human requests to workspace-owned Bots uses the [hosted Exa MCP endpoint](https://exa.ai/docs/get-started/exa-mcp) from the Rust server. Pi can search by keyword or read the text of a public article URL. The host sends only the public search terms or URL and retrieval options. The tools need a direct HTTPS connection to `mcp.exa.ai` and use Exa's keyless rate limits. Interactive work remains on the computer approval path. Scheduled tasks and shared Bot source grants do not automatically include the public research tools.

## Optional release checks

Update checks are disabled by default (`"releases": null`). To enable them, set the intended public GitHub repository in the private server configuration and restart the service:

```json
{ "releases": { "repository": "OWNER/REPOSITORY" } }
```

The repository value is a GitHub owner/repository slug, never a URL, token or private API endpoint. The settings Updates page reads the running Rust version, built web client version and, when available, the native desktop package version separately. Reading this page does not contact GitHub. An authenticated workspace member must explicitly select Check for updates to fetch the configured repository's latest stable release. Results are cached for five minutes; concurrent checks share the result.

The server uses only the fixed GitHub latest-release endpoint, without credentials, redirects or environment proxies. Each request has an eight-second deadline and a 256 KiB response limit. Draft and prerelease releases are rejected. Version comparison follows SemVer; non-version tags are shown as uncomparable rather than as a fabricated latest version. Repository configuration is deployment-wide; checking it does not confer workspace administration rights.

This feature does not establish a release repository or claim that releases have been published. It never downloads or installs an update. Verify the publisher and any release signature before manually updating a deployment or client. The desktop client opens external release links through its existing explicit context-menu confirmation; its general navigation restrictions remain in place.
