# Execution workers

Rust is the business and authorization server. These disposable processes provide the Pi SDK, MCP/OAuth protocol client, browser/computer executor and document codecs. They are not a second business server and do not open the workspace or account SQLite databases. Rust passes each permitted operation and its credentials through the private process protocol.

Build a deployable runtime from the checked-in dependency lock:

```sh
node scripts/build-workers.mjs --out .build/runtime
cd .build/runtime
npm ci --omit=dev --ignore-scripts
```

The build requires the repository's development dependencies, including esbuild. Deployment requires Node 22.19 or newer and only the generated production dependencies. The build preserves exact versions and integrity hashes from the root lock; it does not resolve newer registry versions. It bundles the computer executor's audited file/desktop/network helpers, but rejects business-server and test imports. Browser binaries are a separate explicit deployment prerequisite; building or checking worker health does not install or launch one.

Deploy the runtime directory alongside the Rust executable and point the private server configuration's `runtimeDir` at it. Set `nodeBinary` to the intended Node executable. `workers.json` records the bundle hashes, sizes and source inventory. Do not include source configuration files, `.env`, private databases, browser profiles or formal credentials in the artifact.

Rust prefers the deployed `packages/<name>-worker/index.mjs` bundle. An invalid bundle is an error. If no bundle exists, a source checkout can use `server/workers/<name>-worker/` with the development loader. The document worker uses Node's native TypeScript erasure. Released runtimes do not require `tsx`.
