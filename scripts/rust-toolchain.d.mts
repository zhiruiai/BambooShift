export const root: string;
export type RustOptions = { portable?: boolean };
export function rustEnvironment(options?: RustOptions): NodeJS.ProcessEnv & { CARGO_TARGET_DIR: string };
export function rustBinary(name?: string, release?: boolean, options?: RustOptions): string;
export function cargo(operation: string, args?: string[], options?: RustOptions): Promise<void>;
