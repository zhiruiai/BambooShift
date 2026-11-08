export const MAX_FILE_TRANSFER_BYTES = 10 * 1024 * 1024;

export interface ComputerFileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

export interface ComputerFileListing {
  path: string;
  entries: ComputerFileEntry[];
  truncated: boolean;
}
