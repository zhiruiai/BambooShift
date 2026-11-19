<h1 align="center"><img src="docs/demo/office-cover.svg" alt="aihubot" width="960"></h1>

**English** · [简体中文](README.zh-CN.md)

**aihubot is a self-hosted Bot workspace.** Give a Bot a brief, open its delivery, then change a constraint in the original conversation and review the new version.

[Open the six interactive projects](https://zhiruiai.github.io/aihubot/work/) · [Recordings and evidence](docs/office-workflows.md) · [Quick start](#quick-start) · [Download](https://github.com/zhiruiai/aihubot/releases/latest)

## The rain shells will miss opening day

There are 72 hours until a pop-up opens. Its main supplier now needs 96 hours and the buyer has ¥1,400 less to spend. The Bot changes the three orders from **3 / 1 / 2 cartons to 1 / 3 / 2**. Switch lead times and budgets, inspect the projected margin and download the matching order.

[![Browser footage of six delivered projects, from an outdoor buying desk and a playable coffee film to a reproducible field study](docs/demo/work-studio.gif)](https://zhiruiai.github.io/aihubot/work/)

## Try the work

Each cover opens a working project in Chinese, with no sign-in. Four use fictional business briefs. The technology and research cases use public sources. All six went through a real model and the Rust delivery service.

| Operations and evidence | Content and decisions |
| --- | --- |
| [![Restock a rain-delayed pop-up](docs/showcase-work/posters/commerce.jpg)](https://zhiruiai.github.io/aihubot/work/commerce/)<br>**[Restock a rain-delayed pop-up](https://zhiruiai.github.io/aihubot/work/commerce/)**<br>Change cash and lead time, then download the matching purchase order. | [![Watch the 30-second cut](docs/showcase-work/posters/editorial.jpg)](https://zhiruiai.github.io/aihubot/work/editorial/)<br>**[Watch the 30-second cut](https://zhiruiai.github.io/aihubot/work/editorial/)**<br>Review individual shots and take home the vertical coffee film. |
| [![Rescue a six-session event](docs/showcase-work/posters/operations.jpg)](https://zhiruiai.github.io/aihubot/work/operations/)<br>**[Rescue a six-session event](https://zhiruiai.github.io/aihubot/work/operations/)**<br>Close the main hall and export the replacement schedule to a calendar. | [![Vote on a bookstore pilot](docs/showcase-work/posters/board.jpg)](https://zhiruiai.github.io/aihubot/work/board/)<br>**[Vote on a bookstore pilot](https://zhiruiai.github.io/aihubot/work/board/)**<br>Check the 600-seat arithmetic and take the eight-week proposal to a vote. |
| [![Choose a field database](docs/showcase-work/posters/market.jpg)](https://zhiruiai.github.io/aihubot/work/market/)<br>**[Choose a field database](https://zhiruiai.github.io/aihubot/work/market/)**<br>Switch between offline sampling and concurrent central writes. Inspect the primary sources. | [![Investigate a sign reversal](docs/showcase-work/posters/research.jpg)](https://zhiruiai.github.io/aihubot/work/research/)<br>**[Investigate a sign reversal](https://zhiruiai.github.io/aihubot/work/research/)**<br>Inspect individual penguin observations and compare pooled and within-species correlations. |

## Quick start

- **Join a team.** Open your administrator’s product URL in a browser, or enter it in the macOS Apple Silicon or Windows x64 connection client. Extract the full Windows ZIP before starting the app.
- **Host a workspace.** The Linux x64 package includes the Rust API, both web apps and the workers. Follow the guide to install the Node.js dependencies and configure a private data directory. [Linux installation](server/api/deployment/README.md#install-and-configure)
- **Work on this Mac.** The macOS source build with the bundled runtime can start a local personal workspace and execute approved tasks. The public v0.0.8 desktop clients connect to a separate server. That release uses the former **BambooShift** name. If your old update checker cannot follow the rename, download subsequent releases directly. [Desktop setup](docs/desktop-client.md) · [Releases](https://github.com/zhiruiai/aihubot/releases)

### Run from source

Install stable Rust, Node.js 22.19 or later and npm.

```sh
git clone https://github.com/zhiruiai/aihubot.git
cd aihubot
npm ci
npm run configure:local
npm run dev
```

Open the product URL printed in the terminal. Under **Settings → Models**, save your provider URL, model name and API key, then select **Set as default**. Each Bot inherits the workspace default unless you assign another profile. [Configuration guide](docs/quickstart.en.md)

### Try your first task

> Turn these meeting notes into a Markdown action list and deliver the file here. The content team owes 12 guides on Wednesday. The operations lead owes five reviews on Friday. The budget is still open.

Open the file card. Ask the Bot to split the 12 guides across Wednesday and Thursday. Check that the total stays at 12 and the budget remains open. To try a local walkthrough before connecting a provider, run `npm run dev:preview` with its scripted model and temporary workspace. [Preview instructions](CONTRIBUTING.md#run-a-sample-task-locally)

## Websites, skills and publishing

- **Website delivery.** Open a delivered site from chat, compare revisions, revisit the first version and continue in its original thread. The version-history recording shows saved deliveries from a real model. The playable Starport Landing example comes from a scripted conversation. [Version-history recording](docs/demo/website-delivery.gif) · [Play Starport Landing](https://zhiruiai.github.io/aihubot/en/)
- **Install and run a skill.** In the Bot’s settings, open **Choose and manage skills → Choose from skill library**. Inspect the files in **Data quality review**, install it, attach a CSV and select the skill with `/`. Its Python script returns an exit code and row statistics. The execution Mac needs Python 3 and local command access. [Skill packages and execution](docs/bot-models-and-skills.md)
- **Team and publishing.** Pick a ready-made team in the Bot Gallery or describe the role to the recruiter. For external publishing, configure a supported account and verify the platform receipt. The coffee case delivers a playable MP4 and a downloadable poster. [Team templates](docs/bot-templates.md) · [Publishing accounts](docs/publishing.md)

## Architecture and contributing

React powers the web and Electron workspace. Rust owns task state, permissions, receipts and workspace SQLite data. The Pi worker calls the configured model and requests tools from Rust. MCP connections expose authorized external tools. Flutter is available as source. [Architecture](docs/architecture.md) · [Protocol support and limits](docs/capabilities-and-protocols.md)

Original project code is MIT licensed. Bundled artwork, skills and dependencies retain their respective licenses. [Contribute](CONTRIBUTING.md) · [Report a problem](https://github.com/zhiruiai/aihubot/issues) · [Security](SECURITY.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY.md)
