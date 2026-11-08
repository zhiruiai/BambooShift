import {
  isComputerOperationId,
  type ComputerOperationCancellation,
} from '../../../shared/computer-operations.js';

export interface ComputerOperation {
  readonly id: string;
  readonly abort: AbortController;
  readonly done: Promise<void>;
  finish: () => void;
  settled: boolean;
  cleanupConfirmed: boolean;
}
function fault(code: string, message: string) {
  return Object.assign(new Error(message), { code, status: 409 });
}
export function operationCleanupUnknown(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (('cleanupConfirmed' in error && error.cleanupConfirmed === false) ||
      ('code' in error &&
        ['CLEANUP_UNKNOWN', 'OPERATION_CLEANUP_UNKNOWN'].includes(String(error.code))))
  );
}

/** One registry per screen/incarnation. Finished identifiers remain replay tombstones. */
export class ComputerOperationRegistry {
  private readonly records = new Map<string, ComputerOperation>();
  private poisoned = false;
  constructor(private readonly limit = 10_000) {}
  get available() {
    return !this.poisoned;
  }
  assertAvailable() {
    if (this.poisoned)
      throw fault(
        'OPERATION_CLEANUP_UNKNOWN',
        '无法确认电脑操作已停止，当前画面已停用，请维护并重新连接。',
      );
  }
  poison() {
    this.poisoned = true;
    for (const record of this.records.values()) if (!record.settled) record.abort.abort();
  }
  private create(id: unknown): ComputerOperation {
    if (!isComputerOperationId(id))
      throw Object.assign(new Error('电脑操作标识无效。'), {
        code: 'INVALID_OPERATION_ID',
        status: 400,
      });
    if (this.records.size >= this.limit)
      throw fault('OPERATION_REGISTRY_FULL', '电脑操作记录已满，请维护并重新连接。');
    let finish!: () => void;
    const record: ComputerOperation = {
      id,
      abort: new AbortController(),
      settled: false,
      cleanupConfirmed: false,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    this.records.set(id, record);
    return record;
  }
  reserve(id: unknown): ComputerOperation {
    this.assertAvailable();
    if (!isComputerOperationId(id))
      throw Object.assign(new Error('电脑操作标识无效。'), {
        code: 'INVALID_OPERATION_ID',
        status: 400,
      });
    if (this.records.has(id))
      throw fault('OPERATION_REPLAY', '此电脑操作已处理或取消，请重新提出操作。');
    return this.create(id);
  }
  settle(record: ComputerOperation, error?: unknown) {
    if (record.settled) return;
    if (operationCleanupUnknown(error)) this.poison();
    record.cleanupConfirmed = !this.poisoned;
    record.settled = true;
    record.finish();
  }
  async cancel(id: unknown): Promise<ComputerOperationCancellation> {
    if (!isComputerOperationId(id))
      throw Object.assign(new Error('电脑操作标识无效。'), {
        code: 'INVALID_OPERATION_ID',
        status: 400,
      });
    let record = this.records.get(id);
    if (!record) {
      this.assertAvailable();
      record = this.create(id);
      record.abort.abort();
      this.settle(record); // A delayed execute with this ID can no longer start.
    }
    record.abort.abort();
    await record.done; // A disconnected HTTP client is not proof of cleanup.
    if (!record.cleanupConfirmed)
      throw fault('OPERATION_CLEANUP_UNKNOWN', '无法确认电脑操作已停止，当前画面已停用。');
    return { id, stopped: true, cleanupConfirmed: true };
  }
  async close() {
    for (const record of this.records.values()) if (!record.settled) record.abort.abort();
    await Promise.all([...this.records.values()].map((record) => record.done));
  }
}
