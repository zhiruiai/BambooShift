import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This command only reads preflight permission/display metadata. It cannot capture or input.
const executable = fileURLToPath(new URL('../data/native/OpenBot Desktop Helper.app/Contents/MacOS/OpenBotDesktopHelper', import.meta.url));
if (process.platform !== 'darwin') { console.error('The native desktop helper is available on macOS 14+ only.'); process.exit(1); }
const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8' } });
let data = '', failed = false;
const timer = setTimeout(() => { failed = true; child.kill('SIGTERM'); }, 5000);
const killTimer = setTimeout(() => child.kill('SIGKILL'), 5500);
child.stdout.on('data', chunk => { if (data.length < 64 * 1024) data += chunk; else { failed = true; child.kill('SIGTERM'); } });
child.stdin.on('error', () => { failed = true; });
child.on('error', () => { failed = true; console.error('Desktop helper is not built. Run npm run desktop:build first.'); });
child.once('close', code => {
  clearTimeout(timer); clearTimeout(killTimer);
  if (failed || code !== 0) { process.exitCode = 1; return; }
  try { console.log(JSON.stringify(JSON.parse(data), null, 2)); }
  catch { console.error('Invalid helper status response.'); process.exitCode = 1; }
});
child.stdin.end(JSON.stringify({ op: 'status' }));
