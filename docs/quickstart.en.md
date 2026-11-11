# BambooShift quick start

BambooShift combines a Rust business backend, React product and operations sites, Pi workers, SQLite, an Electron client and Flutter source. Original companion, panda and dinosaur avatars are included; Chinese and English are supported.

Install Rust 1.85+, Node.js 22.19+ (Node 24 recommended) and npm:

```sh
npm ci
npm run configure:local
npm run dev -- --init-operator
```

Open `http://127.0.0.1:5173/login`, register a personal or team account and configure a model in workspace settings. New accounts do not inherit another user's keys, connections or computer credentials.

Ask a workspace Bot to look up current information or read a public article link in a direct chat or group. Pi calls BambooShift's public search and reading tools. Exa receives the public keywords or URL and returns source text. These tools work without an assigned browser, interactive approval, or a separate search key. Keep private or one-time links out of public research.

The independent operations site is at `http://127.0.0.1:5174/admin/setup`. The operator uses the one-time code stored locally at `data/platform/operator-setup-code` to create the first operator account. Later starts omit `--init-operator` and use `/admin/login`. Team ownership is not platform operator permission.

```sh
npm run build
npm start
npm test
npm run check:source
npm run check:privacy
npm run client:dev
npm run source:export -- --out release/source/openbot-v0.1.0
```

Built product and operations listeners default to 3001 and 3002. Use separate HTTPS origins for remote deployment. See [deployment](../server/api/deployment/README.md), [architecture](architecture.md), [operations](operations-console.md) and the [capability audit](reference-audit.md).

Remote computers, local speech models and third-party accounts require separate configuration. Flutter installation builds and device acceptance are deferred. Source exports exclude private data, credentials, dependencies and toolchains. The tool does not create or push a GitHub repository.

BambooShift original source uses [the MIT License](../LICENSE). Keep [NOTICE](../NOTICE) and third-party licenses.
