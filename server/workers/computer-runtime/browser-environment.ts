import { resolve } from 'node:path';

/** A work browser does not need the control process's service or model credentials.
 * This is environment hygiene, not an OS security boundary. */
export function browserEnvironment(
  profileDir: string,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = new Set([
    'PATH',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LANGUAGE',
    'LC_ALL',
    'LC_CTYPE',
    'TZ',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    '__CF_USER_TEXT_ENCODING',
  ]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (allowed.has(key.toUpperCase()) && typeof value === 'string' && !value.includes('\0'))
      env[key] = value;
  }
  // The explicit profile remains persistent; host home/config variables and
  // process instrumentation (NODE_OPTIONS/LD_PRELOAD/etc.) are not inherited.
  env.HOME = resolve(profileDir);
  env.USERPROFILE = env.HOME;
  return env;
}
