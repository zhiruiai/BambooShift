import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { UserConfig } from 'vite';
import { webLicenseInputs } from './web-license-inputs';

type Environment = Record<string, string | undefined>;
const root = fileURLToPath(new URL('../', import.meta.url));

function apiTarget(mode: 'product' | 'operations', env: Environment) {
  const host = env.OPENBOT_BIND_HOST || '127.0.0.1';
  const apiHost =
    host === '::' || host === '::1' ? '[::1]' : host === '0.0.0.0' ? '127.0.0.1' : host;
  const value =
    mode === 'operations'
      ? env.OPENBOT_OPERATIONS_API_PORT || env.PORT || '3002'
      : env.PORT || '3001';
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error('The backend port must be an integer from 1 to 65535.');
  return `http://${apiHost}:${Number(value)}`;
}

export function frontendConfig(
  mode: 'product' | 'operations',
  env: Environment = process.env,
): UserConfig {
  const operations = mode === 'operations';
  const target = apiTarget(mode, env);
  return {
    root: resolve(root, operations ? 'operations' : 'web'),
    envDir: root,
    plugins: [react(), webLicenseInputs(root, mode)],
    ...(operations
      ? { publicDir: false, cacheDir: resolve(root, 'node_modules/.vite-operations') }
      : {}),
    server: {
      host: '127.0.0.1',
      port: operations ? 5174 : 5173,
      strictPort: true,
      watch: {
        ignored: [
          '**/.local/**',
          '**/dist/**',
          '**/data/**',
          '**/release/**',
          '**/.tools/**',
          '**/.build/**',
          '**/config/private/**',
          '**/operations-dist/**',
        ],
      },
      fs: {
        allow: [root],
        deny: [
          '**/.local/**',
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          '**/data/**',
          '**/release/**',
          '**/config/private/**',
          '**/.tools/**',
          '**/.build/**',
        ],
      },
      proxy: operations
        ? { '^/api/platform(?:/|\\?|$)': target, '^/api/health(?:\\?|$)': target }
        : { '/api': target, '^/admin(?:/|\\?|$)': target },
    },
    build: { outDir: resolve(root, operations ? 'operations-dist' : 'dist'), emptyOutDir: true },
  };
}
