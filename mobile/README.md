# BambooShift mobile

Native Flutter client for the Rust service. Android and iOS source projects are
included. The client uses Flutter widgets and the account API directly.

## Develop and verify

Install Flutter 3.47.9 or set `OPENBOT_FLUTTER` to its executable. The helper can
also find Flutter on `PATH`. From this directory:

```sh
./tool/flutter.sh pub get --enforce-lockfile
./tool/flutter.sh analyze --no-pub
./tool/flutter.sh test --no-pub
```

The recorded source checkpoint passed 349 tests with zero analysis issues. See
[verification.json](verification.json) for the source and log digests. The tests
exercise isolated HTTP responses, secure-storage substitutes and offscreen phone
layouts. Android and iOS installers and physical-device acceptance are deferred.

Enter the service origin on the connection screen. Use HTTPS in production;
HTTP is restricted to localhost. Android development can use `adb reverse` to
reach a local Rust service. Deployment addresses, passwords and model keys stay
in private configuration.

## Receive a system share

Choose BambooShift in the Android or iOS share sheet to import text, links, images
or files. BambooShift asks you to select a conversation and review the items before
adding them to its draft. Each file is limited to 10 MiB, with up to four files
per share. The system share queues a local copy. Uploading a file and sending
the draft each require a separate action in the conversation. After attaching
to the draft, unuploaded selections remain in the current workspace session.

On iOS, select **Save to BambooShift** in the Share extension, then open BambooShift to
choose the conversation. To sign for devices, configure the same Apple
Developer team and the `group.dev.openbot.openbotMobile` App Group on Runner
and OpenBotShare. For a fork, keep the App Group identifier in both entitlement
files and `ShareInbox.group` consistent. The extension bundle identifier must
start with the Runner bundle identifier. A local Flutter browser preview can
exercise search and website previews, while the system share sheet requires
an installed native build.

## Client workflows

- Personal and team accounts support login, registration, invitations and simple
  membership management. The platform operations console has its own session.
- Chats display real workspace records. Per-account read acknowledgements cover
  the rendered message watermark only while the chat is visible at its newest
  messages. Personal sections, pinned conversations and hidden recovery use the
  same workspace roster as Web. A lost chat send retains its original request ID.
- Manual Bot/group creation and reviewed intelligent team proposals use durable
  receipts. Bot settings expose memories, skills and routine history; owners can
  review changes, start work explicitly and transfer personal routines. Unknown
  writes are checked against the original operation before further changes.
  In a local Bot's direct chat, the workspace owner can approve up to four exact
  public search queries for a routine. Turning search off clears its grant.
- The Bot library includes template browsing, review, import, editing,
  publication and team sharing. Owners choose exact file and App-tool grants;
  recipients see those grants and can explicitly export authorized files.
- The workspace settings include usage, model profiles, Apps/MCP connections,
  personal memory import, theme, language, original avatar families and service
  version checks. Model secrets are never read back. OAuth uses an explicit
  provider approval flow. Service update checks do not install a mobile app.
- Chat attachment selection, upload, preview and send are separate actions.
  Text and raster previews are bounded; HTML shows source. The native export
  outlet opens a system save/share flow after rechecking access. It reports the
  system result and cleans its own temporary copies on expiry, startup and resume.
- Website projects open from chat and the conversation library. The phone viewer
  displays the pinned version with preview, source files and an explicit ZIP
  export. The viewer checks the size and digest of each file before opening the
  same isolated renderer as Web. Internal pages and bundled assets remain within
  the preview. The renderer runs without the user's BambooShift session credentials.
- A Bot computer can be viewed, explicitly taken over, and taught through
  reviewed action summaries. The generated skill remains a proposal until
  separately approved. Teaching does not save raw keystrokes or screenshots.
- Computer previews support pinch zoom and show capture time. Returning to the
  foreground refreshes the screen after releasing prior control. Server, cloud
  and remote locations are identified without exposing connection credentials.
  Owners can explicitly start/resume a configured cloud computer and connect it
  for at least two hours; reads never start or renew it. They can then confirm
  screen preparation for a Bot when a free slot is available. Unknown outcomes
  are checked by reads and are never automatically repeated. Members see status
  and use screens already prepared by the owner.

## Boundaries

`lib/core` holds transport, session, secure storage and workspace scope. Feature
controllers receive a captured scope and cannot select a different actor through
request bodies. Preview and download requests reject redirects. Recovery state
uses stable identifiers; private model credentials stay out of the client cache
and the source export. Account switches close active requests and fence late
results.

Chinese and English catalogs are split by feature; tests enforce matching keys,
phone layouts and a 12 logical pixel minimum. Device settings preview the
companion, panda, dinosaur, chick and elephant avatar families. Workspace owners
can stage, crop, and use a custom image when creating or editing a Bot. Chat and
roster avatars use authorized images when available. In a workspace with a model,
owners can design an avatar theme in Appearance or review a Bot's theme draft in
chat. Applying a theme saves its design on this device.

Personal workspace owners can open Private skills from Connect apps, review an
approved skill and enable its exact version for another local Bot. Each Bot keeps
its selected version when the original changes. The shelf can disable that
version without changing the source skill or another Bot's assignment.

Android and iOS support microphone dictation and foreground Bot voice calls. Calls
require a configured workspace speech recognizer and an installed offline system
voice. Dictation fills the composer for review. Calls send transcribed turns to the
active direct chat and read its replies aloud with the selected local voice. Leaving
the chat or backgrounding the app ends the call.

In a personal direct chat, use Reply with voice memo to request a spoken
response for one message. The workspace server synthesizes and stores the
memo. Tap its play button to fetch the verified audio, or expand its transcript.
Memo playback uses the stored audio file on Android, iOS and Flutter Web.

Private computer takeover uses the current account, session, and screen. Manual
text starts masked and can be revealed on this device. Ending takeover or leaving
the screen clears the private frame and any unsent text. The computer worker
must report support for private takeover.

Advanced document rendering, manual computer connection, screen reset/release,
and reliable background push still differ from Web. The offscreen tests do not
validate real system pickers, keychains, voices or notifications.

After changing the shared website renderer, regenerate the bundled mobile shell
from the repository root with `node scripts/run.mjs scripts/build-mobile-website-preview.mjs`.
