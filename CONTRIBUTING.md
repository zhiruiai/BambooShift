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

| If you want to improve                                    | Start here                                                                  | Run                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Chat, accessibility, or responsive layout                 | `web/src/workspace/` or `mobile/lib/features/chat/`                         | `npm run test:web` or `cd mobile && ./tool/flutter.sh test`           |
| Add a documented MCP provider                             | `shared/app-providers.json` and both UI languages                           | `npm run sync:app-catalog`, then `npm run check:source`               |
| Change who can use a tool or what happens on cancellation | `server/api/src/agent/` and the matching domain service                     | `npm run backend:test`                                                |
| Add a trusted bundled worker plugin                       | [Cordis host and lifecycle recipe](server/workers/plugin-runtime/README.md) | `node scripts/run.mjs --test server/workers/plugin-runtime/*.test.ts` |
| Improve a worker or the desktop connection flow           | `server/workers/` or `desktop/`                                             | `npm run test:runtime` or `npm run client:test`                       |

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

Keep each first-party source or test file at or below 500 lines. Split code by
responsibility, use English code comments and add visible interface text to both
language catalogs.

Run `npm run lint` before requesting review. The existing CI source check runs the same rules. The check
checks unused locals, imports and parameters in the production TypeScript
projects, then verifies source policy and generated catalogs. Remove obsolete
bindings. Preserve required side effects, public signatures and imports that
register tools. Use an underscore for an unused callback parameter when its
position is required. The normal build still type-checks test fixtures.
[TypeScript locals](https://www.typescriptlang.org/tsconfig/noUnusedLocals.html)
and [parameters](https://www.typescriptlang.org/tsconfig/noUnusedParameters.html).

Choose additional checks for the code you changed.

```sh
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

Mobile CI runs `tool/flutter.sh analyze --no-pub` and the Flutter tests from
`mobile/`. For Rust changes, build and run the affected tests. For additional
lint diagnostics use Clippy from the same stable toolchain as the build.
[Dart static analysis](https://dart.dev/tools/analysis) and
[Clippy guidance](https://doc.rust-lang.org/clippy/continuous_integration/index.html).

### Reviewing a change

- Trace the changed behavior from the user's entry point through its existing
  callers. Identify which existing code can be reused and remove superseded
  branches, state and dependencies after checking their callers.
- Check boundaries where a retry, revoked permission, older saved data or a
  concurrent action could change the result. For a regression, name the test
  that failed before the fix and passed afterward.
- For interface changes, exercise the interaction at desktop and narrow widths.
  Include a screenshot or short recording from a clean workspace when the
  layout or feedback changed. [Google's code review guide](https://google.github.io/eng-practices/review/reviewer/looking-for.html).

In the PR, describe the user-visible outcome, what you ran and what still needs
manual verification. Use synthetic accounts, local protocol fixtures and
temporary data for automatic tests. Keep credentials, browser profiles and
personal paths out of examples, logs and screenshots.

Contributions are provided under the project's [MIT License](LICENSE).
