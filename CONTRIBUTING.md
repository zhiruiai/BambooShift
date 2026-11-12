# Contributing

## Run a sample task locally

Install Node.js 22.19 or later, npm and stable Rust, then run:

```sh
npm ci
npm run dev:preview
```

Open the printed link in a private browser window and sign in with the temporary
account shown in the terminal. Open a Bot chat and send
`Deliver the sample launch checklist.` to create a Markdown file you can preview
or download. The local scripted model drives the real Pi tools. The preview uses
temporary data and removes it when you press Ctrl+C.

Run `npm run dev:preview -- --check` to verify the same workflow without a browser.
Use [the regular development setup](README.md#run-from-source) for live reload or
to test your own model provider.

## Find the right place to contribute

| If you want to improve | Start here | Run |
| --- | --- | --- |
| Chat, accessibility, or responsive layout | `web/src/workspace/` or `mobile/lib/features/chat/` | `npm run test:web` or `cd mobile && ./tool/flutter.sh test` |
| Add a documented MCP provider | `shared/app-providers.json` and both UI languages | `npm run sync:app-catalog`, then `npm run check:source` |
| Change who can use a tool or what happens on cancellation | `server/api/src/agent/` and the matching domain service | `npm run backend:test` |
| Improve a worker or the desktop connection flow | `server/workers/` or `desktop/` | `npm run test:runtime` or `npm run client:test` |

If you are looking for a first change, try reproducing a layout issue at narrow
widths, verifying an installation path, or improving a translation. A screenshot
or small reproduction using sample data can be enough to start a discussion.
See the [architecture guide](docs/architecture.md) for the ownership boundaries.

## Keep changes reviewable

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
