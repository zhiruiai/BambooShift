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

The Bot's settings show enabled skills and drafts awaiting review. Open **Choose
skills**, preview a workflow, edit its instructions and save the draft for that Bot.
Approve it to enable it. Disabling a skill removes it from future task context;
restoring it uses the existing review and version checks. In chat, type `/` to
explicitly select an enabled skill for a task.

Enabled skills are filtered by Bot identity before reaching the model. A proposed,
disabled or foreign Bot's skill cannot be selected for execution. Skills describe
how to work; they do not install plugins, provide credentials or expand tool access.

The bundled English and Chinese catalog contains 17 workflows. Web app testing,
code security review and product documentation are adapted from GitHub Awesome
Copilot. The team decision brief helps compare options for an authorized decision
owner. Debugging and verification are adapted from Superpowers. Product
specifications and team handoffs are adapted from Matt Pocock. See the pinned
[source inventory and licenses](../legal/third-party/community-skills/SOURCES.json).

## Agent Desktop

The **Agent Desktop** workflow is adapted from Vercel Labs' Apache-2.0 skill. It
requires the CLI to be installed separately on the selected execution computer,
operating-system permissions, and BambooShift's approved `local-shell-v1` command
capability. The workflow checks `computer_status`, requests `agent-desktop status`
through `computer_action`, and reads the installed version's desktop and platform
guides. It uses an observe, act and verify loop and preserves action approvals.

Adding or approving this skill does not install the CLI, change the selected
computer, enable physical input, or turn a Windows connection client into a local
runtime. A missing capability is reported before desktop work begins. Native CLI
execution and system permissions must be qualified separately from instruction
selection; an instruction-delivery test is not a desktop-control test.
