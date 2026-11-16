import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateNativeBinary } from './native-binary.mjs';

export const macAccessibilityHelperBundle = 'OpenBot Desktop Helper.app';
const executableInBundle = 'Contents/MacOS/OpenBotDesktopHelper';
const identifier = 'com.openbot.desktop-helper';
const nativeSource = 'server/native/macos';

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(Error(`${command} failed (${code ?? signal}).`));
    });
  });
}

export function verifyMacAccessibilityHelper(bundle, { command = run, sourceRoot } = {}) {
  return command(
    '/usr/bin/codesign',
    ['--verify', '--strict', '-R', `=identifier "${identifier}"`, bundle],
    sourceRoot,
  );
}

export async function buildMacAccessibilityHelper({
  sourceRoot,
  output,
  arch = process.arch,
  command = run,
  testOutput,
}) {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch))
    throw Error('The native desktop helper requires macOS 14+ and Xcode Command Line Tools.');
  const bundle = join(output, macAccessibilityHelperBundle);
  const executable = join(bundle, executableInBundle);
  await mkdir(dirname(executable), { recursive: true });
  const target = arch === 'arm64' ? 'arm64' : 'x86_64';
  const flags = [
    '--sdk',
    'macosx',
    'swiftc',
    '-parse-as-library',
    '-swift-version',
    '5',
    '-target',
    `${target}-apple-macosx14.0`,
  ];
  if (testOutput) {
    const cache = join(testOutput, 'module-cache');
    await mkdir(cache, { recursive: true });
    flags.push('-module-cache-path', cache);
  }
  const core = `${nativeSource}/DesktopCore.swift`;
  await command(
    '/usr/bin/xcrun',
    [
      ...flags,
      '-O',
      core,
      `${nativeSource}/DesktopAccessibility.swift`,
      `${nativeSource}/DesktopHelper.swift`,
      '-o',
      executable,
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
      '-framework',
      'ScreenCaptureKit',
      '-framework',
      'CoreGraphics',
    ],
    sourceRoot,
  );
  await validateNativeBinary(executable, { platform: 'darwin', arch });
  await copyFile(join(sourceRoot, nativeSource, 'Info.plist'), join(bundle, 'Contents/Info.plist'));
  await command(
    '/usr/bin/codesign',
    ['--force', '--sign', '-', '--identifier', identifier, '--options', 'runtime', bundle],
    sourceRoot,
  );
  await verifyMacAccessibilityHelper(bundle, { sourceRoot, command });
  if (testOutput) {
    // Geometry and key validation link no capture or input code.
    const tests = join(testOutput, 'DesktopCoreTests');
    await command(
      '/usr/bin/xcrun',
      [...flags, core, `${nativeSource}/DesktopCoreTests.swift`, '-o', tests],
      sourceRoot,
    );
    await command(tests, [], sourceRoot);
  }
  return executable;
}

export async function stageMacAccessibilityHelper({ output, sourceRoot, platform, arch, command }) {
  if (platform !== 'darwin') return {};
  await buildMacAccessibilityHelper({ sourceRoot, output: join(output, 'bin'), arch, command });
  return { accessibilityHelper: `bin/${macAccessibilityHelperBundle}/${executableInBundle}` };
}
