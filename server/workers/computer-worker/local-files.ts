import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  listComputerEntries,
  readComputerText,
  writeComputerText,
} from '../computer-runtime/computer-files.js';
import { terminalCommands } from './protocol.js';

const execFileAsync = promisify(execFile);

export async function executeLocalFileAction(
  workspace: string,
  action: {
    type: 'list_files' | 'read_file' | 'write_file' | 'terminal_command';
    path?: string;
    content?: string;
    command?: string;
  },
  signal?: AbortSignal,
) {
  switch (action.type) {
    case 'list_files':
      return {
        path: action.path ?? '.',
        entries: await listComputerEntries(workspace, action.path, signal),
      };
    case 'read_file':
      return {
        path: action.path,
        content: await readComputerText(workspace, action.path!, signal),
      };
    case 'write_file':
      await writeComputerText(workspace, action.path!, action.content!, signal);
      return { path: action.path, bytes: Buffer.byteLength(action.content!) };
    case 'terminal_command': {
      const [command, args] = terminalCommands[action.command!];
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: workspace,
        timeout: 5_000,
        maxBuffer: 100_000,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
      });
      return { command: action.command, stdout, stderr };
    }
  }
}
