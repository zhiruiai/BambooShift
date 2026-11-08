import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, delimiter } from 'node:path';
import { root, rustBinary, rustEnvironment } from './rust-toolchain.mjs';

export function backendLaunch(explicit = [], env = process.env) {
  const config = resolve(env.OPENBOT_SERVER_CONFIG || 'config/private/server.private.json');
  const explicitDeployment = explicit.some((arg) => arg === '--config' || arg === '--data-dir');
  const args = explicitDeployment ? [...explicit] : ['--config', config, ...explicit];
  if (!explicitDeployment && !existsSync(config))
    throw new Error(
      'Create a private server configuration first: npm run configure:local. Deployment data is never selected implicitly.',
    );
  const executable = env.OPENBOT_BACKEND_BINARY || rustBinary();
  if (/(?:^|[\\/])server[\\/]index\.[cm]?[jt]s$/.test(executable))
    throw new Error(
      'The former Node business server cannot be used as OPENBOT_BACKEND_BINARY. Select the Rust backend.',
    );
  if (!existsSync(executable))
    throw new Error('Build the Rust backend first: npm run backend:build.');
  return {
    executable,
    args,
    options: {
      cwd: root,
      env: {
        ...rustEnvironment(),
        ...env,
        PATH: `${dirname(process.execPath)}${delimiter}${env.PATH || ''}`,
      },
    },
  };
}

// Return the Rust process itself so supervisors can signal and await the actual writer.
export function launchBackend(
  explicit = [],
  { env = process.env, stdio = 'inherit', launch = spawn } = {},
) {
  const { executable, args, options } = backendLaunch(explicit, env);
  return launch(executable, args, { ...options, stdio });
}
