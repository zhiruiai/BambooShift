import { lstat, readFile } from 'node:fs/promises';
import { providers, required, routeKey } from './protocol.mjs';

const envName = (value) => /^[A-Z][A-Z0-9_]{2,100}$/.test(required(value));
export function validateConfig(value) {
  if (value?.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 20)
    throw Error('Invalid IM configuration');
  const origin = new URL(value.origin);
  if (
    origin.origin !== value.origin ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === 'https:' ||
      (origin.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(origin.hostname))
    )
  )
    throw Error('Use a fixed HTTPS or loopback BambooShift origin');
  const accounts = new Set(),
    routes = new Set(),
    chats = new Set();
  for (const account of value.accounts) {
    required(account.id);
    if (
      accounts.has(account.id) ||
      !providers.includes(account.provider) ||
      !envName(account.secretEnv)
    )
      throw Error('Invalid channel account');
    accounts.add(account.id);
    required(account.clientId);
    if (account.provider === 'feishu') required(account.botId);
    if (!Array.isArray(account.bindings) || account.bindings.length > 100)
      throw Error('Invalid bindings');
    for (const b of account.bindings) {
      for (const key of [
        'senderId',
        'chatId',
        'workspaceId',
        'userId',
        'conversationId',
        'agentId',
      ])
        required(b[key]);
      if (b.threadId) required(b.threadId);
      if (!envName(b.sessionEnv) || typeof b.allowGroup !== 'boolean')
        throw Error('Invalid binding');
      const key = routeKey({ ...b, accountId: account.id });
      const chat = JSON.stringify([b.workspaceId, b.conversationId]);
      if (routes.has(key) || chats.has(chat))
        throw Error('Every external identity needs a separate dedicated conversation');
      routes.add(key);
      chats.add(chat);
    }
  }
  return value;
}
export async function readPrivateConfig(path) {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.size > 128 * 1024 ||
    (process.platform !== 'win32' && (stat.uid !== process.getuid() || stat.mode & 0o077))
  )
    throw Error('IM config must be an owner-only regular file');
  return validateConfig(JSON.parse(await readFile(path, 'utf8')));
}
export function resolveSecret(name, env = process.env) {
  const value = env[name];
  if (!envName(name) || typeof value !== 'string' || !value || /[\r\n]/.test(value))
    throw Error('Required channel credential is missing');
  return value;
}
