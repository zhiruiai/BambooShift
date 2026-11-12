import { access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export interface CuaEndpoint {
  executablePath: string;
  socketPath: string;
}
export interface CuaResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; data?: string; mimeType?: string }>;
}
export interface CuaConnection {
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CuaResult>;
  close(): Promise<void>;
}
export type CuaConnectionFactory = (
  endpoint: CuaEndpoint,
  signal: AbortSignal,
) => Promise<CuaConnection>;

/** Connect only to the private daemon already owned by Electron. Never launch a daemon here. */
export const openCuaConnection: CuaConnectionFactory = async (endpoint, signal) => {
  for (const path of [endpoint.executablePath, endpoint.socketPath])
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
      throw new Error('桌面驱动路径无效。');
  signal.throwIfAborted();
  await access(endpoint.executablePath, constants.X_OK);
  const socket = await lstat(endpoint.socketPath);
  if (!socket.isSocket() || socket.uid !== process.getuid?.() || (socket.mode & 0o077) !== 0)
    throw new Error('桌面驱动连接不是当前用户的私有连接。');
  const client = new Client(
    { name: 'bambooshift-desktop', version: '0.0.1' },
    { capabilities: {}, listMaxPages: 4, versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StdioClientTransport({
    command: endpoint.executablePath,
    args: ['mcp', '--embedded', '--socket', endpoint.socketPath],
    env: { CUA_DRIVER_EMBEDDED: '1' },
    stderr: 'ignore',
    maxBufferSize: 16 * 1024 * 1024,
  });
  let closed = false;
  client.onclose = () => {
    closed = true;
  };
  try {
    await client.connect(transport, { signal, timeout: 15_000 });
    const { tools } = await client.listTools(undefined, { signal, timeout: 15_000 });
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of [
      'check_permissions',
      'get_screen_size',
      'get_desktop_state',
      'click',
      'drag',
      'scroll',
      'type_text',
      'press_key',
    ])
      if (!names.has(name)) throw new Error('桌面驱动缺少所需功能，请更新桌面应用。');
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    async call(name, args, signal) {
      signal.throwIfAborted();
      if (closed) throw new Error('桌面驱动连接已结束，请重启本地工作空间。');
      // The SDK owns transport cancellation. No retry of an input request is safe here.
      return (await client.callTool(
        { name, arguments: args },
        { signal, timeout: 30_000 },
      )) as CuaResult;
    },
    async close() {
      closed = true;
      await client.close();
    },
  };
};
