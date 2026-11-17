# Models and skills for each Bot

Open a Bot's settings to choose its model and manage its enabled skills. The same
controls are available in the Web, desktop and Flutter clients. Only a workspace
owner can change a local Bot's configuration.

## Choose a model

Configure the provider, model and credentials once in workspace model settings.
Then choose a configured profile in the Bot's settings, or leave **Workspace
default** selected. Creating a Bot or a new team member also supports this choice.
Web and desktop can create a primary assistant directly with a model choice;
Flutter selects an existing Bot as primary, preserving its saved model preference.
It changes that Bot's preference, not the workspace default.

Group delegation resolves each Bot's model independently. A running Bot retains
its task's model snapshot; subsequent tasks use saved settings. A missing or
unconfigured explicit selection produces an error instead of silently changing
providers. A profile assigned to a Bot cannot be deleted until that assignment is
removed. Shared Bots use the executing workspace's default model; their source
workspace's profile identifiers and credentials are not transferred. Published
templates do not carry model bindings.

## Choose skills

Every local Bot starts with four complete packages: **Web research**, **Browser
use**, **Computer use**, and **Agent Desktop**. This applies to the initial Bot,
manual creation, recruitment, templates and teams. Existing local Bots receive
missing packages once on workspace initialization; shared Bots keep their source
definition. Existing authored or disabled packages are preserved, and later
removing or disabling a foundational package is not undone on restart.

These packages teach the real tool paths. Research uses `web_search` and
`web_fetch`; browser work uses the existing Playwright worker; native Mac work
uses application controls when available. The optional Vercel Agent Desktop CLI
remains a separate prerequisite. Neither package installation nor initialization
grants computer access, creates credentials, installs software or enables a screen.

In the Web and desktop clients, the Bot's settings show enabled skills and drafts
awaiting review. Open **Choose skills**, select a package and its target Bot, then
choose **Install**. The complete
package is saved and enabled together. The page confirms which Bot can now use it.
Instructions and files remain available in the package preview. A repeated install
of the same package reuses the existing version. An update explicitly replaces the
reviewed active version and retains the old version in history.
Disabling a skill removes it from future task context;
restoring it uses the existing review and version checks. In chat, type `/` to
explicitly select an enabled skill for a task.

Enabled skills are filtered by Bot identity before reaching the model. A proposed,
disabled or foreign Bot's skill cannot be selected for execution. Skills describe
how to work; they do not install plugins, provide credentials or expand tool access.

### Import an Agent Skills package

From a Bot's skills, select **Import Agent Skill folder** and choose the directory
that contains `SKILL.md`. Review the manifest and accompanying files, then choose
**Install** to enable the complete package for the selected Bot. Custom authored
drafts and Bot-proposed changes retain their separate review step. The required
`name` matches the directory. The package
keeps the standard optional metadata and relative resources, including files under
`scripts/`, `references/` and `assets/`. Each version can be downloaded as a ZIP
with its directory structure. [Agent Skills specification](https://agentskills.io/specification)

An installed package starts with name and description in the run catalog. The Bot
loads the approved instructions with `read_skill`, then loads individual resources
with `read_skill_resource`. Resource reads target the approved version captured for
the run. The experimental `allowed-tools` field is retained as portable metadata.
[Integration guide](https://agentskills.io/client-implementation/adding-skills-support)

### Run a bundled script on this Mac

A local Bot in the macOS desktop app can request `run_skill_script` in the owner's
direct task when local command access is enabled. The request names the reviewed
skill version, a `.py` or `.mjs` path under `scripts/`, the exact arguments and any
CSV attachment from that chat. The attachment can be up to 256 KiB. With **Ask
each time**, approve that request in the chat. With **Full access** for this
computer, it runs under the saved authorization without another confirmation.
The executor verifies the package and runs it from its skill
directory on this Mac. The receipt includes the exit code and output.

Open **Computer → Default computer permissions** to choose **Full access** or
**Ask each time**. All Bots use this default for tasks requested by the
granting workspace owner on that computer, including app operations, file actions,
commands and skill scripts. It survives a normal restart on the same Mac. Execution
receipts remain visible. Selecting **Ask each time** revokes the grant, including
while a command is running. Operating-system permissions and stop controls still
apply.

When local control is enabled, the same owner's saved full grant and ready OS
permissions allow a restarted local executor to restore its saved app or desktop
surface. An explicit browser choice remains in effect. Opening an installed app
can use an audited local `/usr/bin/open` command when the native control surface
is unavailable; inspecting or editing app controls still requires Accessibility.
Re-signing an ad-hoc development app can invalidate its OS permission without
removing BambooShift's saved grant. See [desktop permissions and signing](desktop-client.md).

For **Data quality review**, attach a CSV and ask the Bot to check it. Specify
the key column if you want duplicate-key counts. The bundled script reports
record count, malformed widths, blanks and duplicate-key rows. A Python 3 runtime
is required for this script.

The English and Chinese library contains 27 skill packages. Each includes a
reference checklist and a working template. Data quality review and spreadsheet
analysis also include a Python script for profiling CSV files. Web app testing,
code security review and product documentation are adapted from GitHub Awesome
Copilot. Debugging and verification are adapted from Superpowers. Product
specifications and team handoffs are adapted from Matt Pocock. The Superpowers
engineering package additionally retains complete pinned upstream directories for
systematic debugging, test-driven development, review feedback and completion
verification, including supporting references and a file-hash inventory. It does
not install upstream hooks or execute reference scripts automatically.

Frontend design retains the complete Anthropic design guidance as a reference;
its package declares **MIT AND Apache-2.0**, preserves both licenses, and records
the upstream revision and hash. Agent Desktop retains **Apache-2.0**. Other bundled
workflows use MIT. Skill discovery, skill creation and connector development
include review checklists and portable working files. All adapted packages retain
their actual source and license. [Source inventory](../legal/third-party/community-skills/SOURCES.json)

The Bot Gallery's starter packages include working files tailored to each role.
The research Bot includes a claims spreadsheet template, and the recruiter has a
structured Bot brief. Choosing **Use template and edit** retains these role
packages while you customize the profile. The form previews the packages; they
are installed together with the Bot only after submission. Cancelling the draft
creates nothing. [Bot Gallery](bot-templates.md)

## Agent Desktop

The **Agent Desktop** workflow is adapted from Vercel Labs' Apache-2.0 skill. It
checks `computer_status` and prefers BambooShift's available native app controls.
The optional external CLI path requires a separately installed CLI on the selected
execution computer, operating-system permissions and authorized `local-shell-v1`
commands. On that path, the Bot requests `agent-desktop status` through
`computer_action` and reads the installed version's desktop and platform guides.
Both paths observe, act and verify through the current computer authorization.

Adding or approving this skill does not install the CLI, change the selected
computer, enable physical input, or turn a Windows connection client into a local
runtime. A missing capability is reported before desktop work begins. Native CLI
execution and system permissions must be qualified separately from instruction
selection; an instruction-delivery test is not a desktop-control test.
