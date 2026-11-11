import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { normalizePath, type UserConfig } from 'vite';
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
  projectRoot = root,
): UserConfig {
  // Anchor deployment directories to this checkout, not an identically named
  // ancestor (for example a source archive unpacked below release/ or data/).
  const scoped = (directory: string) =>
    normalizePath(resolve(projectRoot)).replace(/([*?\[\]{}()!+@])/g, '\\$1') +
    '/**/' +
    directory +
    '/**';
  const operations = mode === 'operations';
  const target = apiTarget(mode, env);
  return {
    root: resolve(projectRoot, operations ? 'operations' : 'web'),
    envDir: projectRoot,
    plugins: [react(), webLicenseInputs(projectRoot, mode)],
    ...(operations
      ? { publicDir: false, cacheDir: resolve(projectRoot, 'node_modules/.vite-operations') }
      : {}),
    server: {
      host: '127.0.0.1',
      port: operations ? 5174 : 5173,
      strictPort: true,
      watch: {
        ignored: [
          scoped('.local'),
          scoped('dist'),
          scoped('data'),
          scoped('release'),
          scoped('.tools'),
          scoped('.build'),
          scoped('config/private'),
          scoped('operations-dist'),
        ],
      },
      fs: {
        allow: [projectRoot],
        deny: [
          scoped('.local'),
          '.env',
          '.env.*',
          '*.{crt,pem}',
          '**/.git/**',
          scoped('data'),
          scoped('release'),
          scoped('config/private'),
          scoped('.tools'),
          scoped('.build'),
        ],
      },
      proxy: operations
        ? { '^/api/platform(?:/|\\?|$)': target, '^/api/health(?:\\?|$)': target }
        : { '/api': target, '^/admin(?:/|\\?|$)': target },
    },
    build: {
      outDir: resolve(projectRoot, operations ? 'operations-dist' : 'dist'),
      emptyOutDir: true,
    },
  };
}
