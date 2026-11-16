import { writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  macAccessibilityHelperBundle,
  verifyMacAccessibilityHelper,
} from './macos-accessibility-helper.mjs';

export async function signLocalMacClient({
  app,
  electronVersion,
  working,
  bundledRuntime,
  command,
}) {
  const { sign } = await import('@electron/osx-sign');
  // Ad-hoc code has no Apple Team ID. Permit its bundled Electron libraries while
  // retaining hardened runtime and V8 JIT. These are app entitlements, not TCC grants.
  const entitlements = join(working, 'client-entitlements.plist');
  const pluginEntitlements = join(working, 'client-plugin-entitlements.plist');
  const plist = (plugin) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  ${plugin ? '<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>' : ''}
</dict></plist>
`;
  await writeFile(entitlements, plist(false));
  await writeFile(pluginEntitlements, plist(true));
  const helper = bundledRuntime?.accessibilityHelper
    ? resolve(app, 'Contents/Resources/bambooshift-runtime/bin', macAccessibilityHelperBundle)
    : undefined;
  console.log('正在为本机测试签名并校验 macOS 客户端（ad-hoc）。');
  // osx-sign signs nested code before its containing bundle. Do not use --deep to sign.
  await sign({
    app,
    platform: 'darwin',
    version: electronVersion,
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    // The native helper is already hardened and signed without Electron entitlements.
    ...(helper ? { ignore: (path) => path === helper || path.startsWith(`${helper}${sep}`) } : {}),
    optionsForFile: (path) => ({
      entitlements: path.includes('(Plugin).app') ? pluginEntitlements : entitlements,
      hardenedRuntime: true,
      timestamp: 'none',
    }),
  });
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  if (helper) await verifyMacAccessibilityHelper(helper, { command });
}
