# PandaMate

[简体中文](README.md) · English

**An open-source, self-hosted Grok Bot alternative.** PandaMate is an AI workspace for individuals and teams. Give AI coworkers distinct roles in the same group chat, schedule recurring work, and check web sources and previews without leaving the conversation.

[Quick start](#quick-start) · [Demos](#demos) · [Build and deploy](#build-and-deploy) · [Source map](#source-map) · [Open-source credits](#open-source-credits) · [Contributing and license](#contributing-and-license)

## Quick start

Download or clone this repository. Install the stable Rust toolchain, Node.js 22.19 or later (24 recommended), and npm. Run these commands from the repository root.

```sh
npm ci
npm run configure:local
npm run dev
```

1. Open the product URL printed in the terminal and register a personal or team account.
2. Open **Settings → Model settings** in your workspace. Enter the model provider URL, model name, and API key. Save the profile, then choose **Set as default**.
3. Open a Bot chat and try asking it to find the official Pi Coding Agent documentation, summarize three key points, and cite its sources. Expand the search record above the reply to review the sources.

Run `configure:local` once to create the local configuration. To start an already configured workspace, run `npm run dev`. To set up the separate operations account on first launch, run `npm run dev -- --init-operator`. [Operations setup](docs/operations-console.md)

## What you can do

| Use case | Features |
| --- | --- |
| AI coworkers and multi-agent collaboration | Direct and group chats, Bot mentions, role templates, delegation, and question cards. Preview an individual Bot or team draft before creating it. |
| Web research with sources | Search public web pages and review the sources. Preview documents, spreadsheets, media, and multi-file website projects in chat. |
| Agent workflow automation and reusable skills | Schedule recurring tasks with a time zone and check past runs. Save repeatable instructions as Bot skills and review them before activation. |
| MCP tools and human-in-the-loop approvals | Connect apps through the Model Context Protocol (MCP) and approve specific tool calls. Browser control, remote computers, and local speech transcription can be configured separately. |

The web app supports PWA installation. The desktop and mobile clients connect to the same workspace service. Start that service before connecting a client. [Electron desktop](docs/desktop-client.md) · [Flutter mobile](mobile/README.md)

## Demos

Start a football tactics room with a coach, a striker, and a data analyst.

![Selecting roles and creating a football tactics group chat](docs/demo/group-chat.gif)

<details>
<summary>Group chats and personalization · Questions, role-play, and avatars</summary>

**Change tactics mid-game.** Choose high pressing and quick attacks down the wings in the question card. The coach continues with those choices.

![Submitting tactical choices in a group chat and viewing the follow-up](docs/demo/chat-choices.gif)

**Founder debate.** Mention everyone and let four fictional characters pitch an AI tutor they could build on the same old computer.

![Asking everyone in a group chat to answer the same question](docs/demo/founder-debate.gif)

**Give the team a new look.** Preview panda, dinosaur, chick, and elephant themes, then return to the group chat to see the result.

![Changing the avatar theme for a group chat](docs/demo/avatar-themes.gif)

</details>

<details>
<summary>Templates and automation · Teams, briefings, and skills</summary>

**Team templates.** Review the three Bots and their responsibilities, then edit the draft and create the group.

![Reviewing roles and creating a team](docs/demo/team-templates.gif)

**Weekday briefings.** Choose how often the task runs and when, then check the next scheduled run.

![Setting a schedule and confirming the next run](docs/demo/scheduled-brief.gif)

**Research skills.** Preview built-in instructions, then choose a Bot and save the skill as a draft for review.

![Previewing research instructions and saving a draft](docs/demo/skill-library.gif)

</details>

<details>
<summary>Research and deliverables · Public sources and website previews</summary>

**Web research.** Expand the search record in chat to review the pages the Bot read and their sources.

![Reviewing public web research sources](docs/demo/web-research.gif)

**Multi-file websites.** Open the deliverable from chat, browse the pages, and switch to the source files.

![Previewing a multi-file website and viewing its source](docs/demo/website-preview.gif)

</details>

## Build and deploy

A Rust service handles identity, permissions, application data, and scheduling, and stores state in SQLite. Pi provides the Bot agent harness. Separate workers handle MCP, document parsing, and computer use. The React product and operations sites are built separately and use separate API entry points and sign-in sessions. [Architecture](docs/architecture.md)

| Command | Purpose |
| --- | --- |
| `npm run build` | Compile the Rust service and build the product and operations sites |
| `npm start` | Start the built service with local configuration |
| `npm run client:dev` | Run the Electron client and connect it to the product service |
| `npm test` | Run backend, web, worker, and desktop client tests |
| `npm run check:source` · `npm run check:privacy` | Check source rules and scan publishable files for private values |
| `npm run backend:package -- --release --out release/backend` | Assemble a release package for the current platform |

Use HTTPS for production. Configure the product and operations entry points separately and store data outside the release package. Model providers, third-party apps, remote computers, and local speech each have their own setup. Flutter includes Android and iOS source and test workflows. Native installation and device testing are separate steps. [Service deployment](server/api/deployment/README.md) · [Source releases](docs/source-release.md) · [Verification coverage](docs/verification.md)

## Source map

Developers and AI agents can use this map to find the entry points, implementation, and checks for a change.

| Area | Where to start | Relevant checks |
| --- | --- | --- |
| Product UI | [Web entry](web/src/main.tsx), [UI source](web/src/), [static assets](web/public/) | `npm run test:web` |
| Separate operations site | [Operations entry](operations/main.tsx), [operations pages](operations/src/) | `npm run build:operations` |
| Rust API, permissions, and persistence | [Service entry](server/api/src/main.rs), [API implementation](server/api/src/), [integration tests](server/api/tests/) | `npm run backend:test` |
| Pi, MCP, document, and computer workers | [Workers](server/workers/), [native helpers](server/native/) | `npm run test:runtime` |
| Electron and Flutter | [Desktop](desktop/), [mobile](mobile/) | `npm run client:test` · [Flutter checks](mobile/README.md#develop-and-verify) |
| Shared types and protocols | [Shared source](shared/) | `npm run test:web` · `npm run test:runtime` |
| Build, export, and privacy checks | [Scripts](scripts/), [source checks](scripts/source/) | `npm run check:source` · `npm run check:privacy` |

Development commands live in [package.json](package.json) and continuous integration in [.github/workflows/ci.yml](.github/workflows/ci.yml). The Rust service determines permissions and task state. For changes involving permissions or writes, trace the behavior through the API, persistence, and tests. [Contribution guide](CONTRIBUTING.md)

## Data and external services

Workspace data lives on the service managed by the deployer. Model requests go to the configured provider. Public web research sends query terms or public URLs to Exa. Connected apps and computer workers use their configured endpoints and permissions. Store deployment settings, model credentials, runtime data, and browser profiles outside source control. [External apps](docs/app-connections.md) · [Security](SECURITY.md)

## Open-source credits

Thanks to the maintainers and contributors of the projects below.

| Area | Upstream projects and components |
| --- | --- |
| Agent execution and tool connections | [Pi Coding Agent](https://github.com/earendil-works/pi) provides the Bot execution harness. The [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) connects external tools. |
| Server and storage | [Tokio](https://tokio.rs/) and [Axum](https://github.com/tokio-rs/axum) support the Rust service. [SQLx](https://github.com/transact-rs/sqlx) accesses [SQLite](https://sqlite.org/). |
| Web, desktop, and mobile | [React](https://react.dev/) and [Vite](https://vite.dev/) power the web front end. [Electron](https://www.electronjs.org/) and [Flutter](https://flutter.dev/) are used for the desktop and mobile clients, respectively. |
| Documents, icons, and fonts | [PDF.js](https://mozilla.github.io/pdf.js/) and [Mammoth.js](https://github.com/mwilliamson/mammoth.js) handle document previews and parsing. [Lucide](https://lucide.dev/) provides UI icons. The Chinese font in Flutter web is derived from [Noto Sans SC](https://fonts.google.com/noto/specimen/Noto+Sans+SC). |
| Optional execution environments | [Playwright](https://playwright.dev/) and [Chromium](https://www.chromium.org/) support browser use. [whisper.cpp](https://github.com/ggml-org/whisper.cpp) handles local speech transcription. |

PandaMate is an independent project. For the original product reference, see the [official Grok Bot introduction](https://x.ai/news/introducing-grok-bot).

Lockfiles record dependency versions. Dependencies retain their original licenses. The packaged service includes a license inventory for its compiled Rust and bundled web dependencies. [NOTICE](NOTICE) · [Third-party licenses](THIRD_PARTY.md)

## Contributing and license

Bug reproductions, documentation improvements, and code changes are welcome. Use sample data in reproductions and include the checks you ran. [Contribution guide](CONTRIBUTING.md)

PandaMate's source is licensed under the [Apache License 2.0](LICENSE).
