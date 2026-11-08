import { mkdir, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.platform !== 'darwin') { console.error('The native desktop helper requires macOS 14+ and Xcode Command Line Tools.'); process.exit(1); }
const output = resolve(root, 'data/native');
const bundle = resolve(output, 'OpenBot Desktop Helper.app');
const executable = resolve(bundle, 'Contents/MacOS/OpenBotDesktopHelper');
const moduleCache = resolve(output, 'module-cache');
await mkdir(resolve(bundle, 'Contents/MacOS'), { recursive: true });
await mkdir(moduleCache, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
  return result;
}
const sdk = run('/usr/bin/xcrun', ['--show-sdk-path'], { stdio: 'pipe', encoding: 'utf8' }).stdout.trim();
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const common = ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', `${architecture}-apple-macosx14.0`, '-sdk', sdk, '-module-cache-path', moduleCache];
run('/usr/bin/xcrun', [...common, '-O', 'server/native/macos/DesktopCore.swift', 'server/native/macos/DesktopHelper.swift', '-o', executable, '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit', '-framework', 'CoreGraphics']);
await copyFile(resolve(root, 'server/native/macos/Info.plist'), resolve(bundle, 'Contents/Info.plist'));
run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'com.openbot.desktop-helper', bundle]);
// Pure geometry/key validation executable. It links no desktop capture or input implementation.
const tests = resolve(output, 'DesktopCoreTests');
run('/usr/bin/xcrun', [...common, 'server/native/macos/DesktopCore.swift', 'server/native/macos/DesktopCoreTests.swift', '-o', tests]);
run(tests, []);
console.log(`Built ${executable}`);
console.log('No screen was captured, no input was sent, and no permission prompt was requested.');
