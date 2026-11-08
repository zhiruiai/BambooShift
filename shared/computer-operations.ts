export const OPERATION_CLEANUP_CAPABILITY = 'operation-cleanup-v1';
export const COMPUTER_OPERATION_ID_HEADER = 'X-OpenBot-Operation-Id';
export function isComputerOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
  );
}
export interface ComputerOperationCancellation {
  id: string;
  stopped: true;
  cleanupConfirmed: true;
}
