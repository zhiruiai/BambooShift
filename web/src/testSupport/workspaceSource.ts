import { uiText } from '../i18n';
import { readFile, readdir } from 'node:fs/promises';
import { runInNewContext, type Context, type RunningCodeOptions } from 'node:vm';

/** Read the real workspace modules for focused handler/binding tests. */
export async function workspaceSource() {
  const names = (await readdir('web/src/workspace')).filter((name) => /\.(ts|tsx)$/.test(name));
  return (await Promise.all(names.map((name) => readFile(`web/src/workspace/${name}`, 'utf8')))).join(
    '\n',
  );
}

/** Supply the same explicit dependency reader used by the extracted action factories. */
export function runInWorkspaceContext(
  code: string,
  context: Context = {},
  options?: RunningCodeOptions,
) {
  context.uiText ??= uiText;
  context.read ??= () => context;
  context.workspaceState ??= context;
  return runInNewContext(code, context, options);
}
