# Contributing

Use Rust for business APIs, authorization, persistent state and scheduling. The
Rust service lives in `server/api/`. The processes in `server/workers/` execute
Pi, MCP, document and computer SDKs behind explicit protocols. The product site
lives in `web/`, and the independent operations site lives in `operations/`.
The Flutter and Electron clients in `mobile/` and `desktop/` use the same
workspace APIs.

Keep each first-party source or test file at or below 500 lines. Use English code
comments and put visible interface text in the Chinese and English catalogs. Split
code by responsibility rather than compressing it to satisfy a line limit.

Start with the setup instructions in [README.md](README.md). Run the checks relevant
to your change:

```sh
npm run check:source
npm run check:privacy
npm run backend:test
npm run test:web
npm run test:runtime
npm run client:test
npm run build:web
```

Browser integration tests require a Chrome installation. Set `CHROME_EXECUTABLE`
and `OPENBOT_BROWSER_EXECUTABLE` to its absolute executable path, then run
`npm run test:browser`. Optional Linux desktop tests require the tools documented
in [docs/linux-desktop.md](docs/linux-desktop.md). Mobile package builds and device
acceptance are separate from source analysis and tests.

Write tests for behavior, authorization, cancellation and recovery. Use synthetic
accounts, local protocol fixtures and temporary data. Keep real model calls,
remote-computer operations and publication separate from automatic tests.

Explain the observable change and validation in a pull request. Keep credentials,
private addresses, runtime databases, browser profiles, build artifacts and local
machine paths out of commits. Configuration examples must use placeholders.

Contributions are provided under the project's [MIT License](LICENSE).
