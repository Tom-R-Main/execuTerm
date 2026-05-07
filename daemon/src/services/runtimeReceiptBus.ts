import { randomUUID } from 'node:crypto';

export type RuntimeReceiptType =
  | 'agent.registered'
  | 'agent.transitioned'
  | 'work_item.heartbeat_synced'
  | 'work_item.needs_review_synced'
  | 'work_item.failed_synced'
  | 'work_item.released_synced'
  | 'checkpoint.saved'
  | 'checkpoint.failed'
  | 'dispatch.work_item_created'
  | 'dispatch.work_item_claimed'
  | 'dispatch.work_item_started'
  | 'dispatch.workspace_launched';

export interface RuntimeReceipt {
  id: string;
  type: RuntimeReceiptType;
  timestamp: string;
  workspaceId?: string;
  taskId?: string;
  workItemId?: string;
  agentType?: string;
  attributes?: Record<string, unknown>;
}

interface PendingWaiter {
  type: RuntimeReceiptType;
  predicate?: (receipt: RuntimeReceipt) => boolean;
  resolve: (receipt: RuntimeReceipt) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RuntimeReceiptBus {
  private receipts: RuntimeReceipt[] = [];
  private waiters = new Map<string, PendingWaiter>();

  publish(input: Omit<RuntimeReceipt, 'id' | 'timestamp'>): RuntimeReceipt {
    const receipt: RuntimeReceipt = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };
    this.receipts.push(receipt);
    if (this.receipts.length > 500) {
      this.receipts.splice(0, this.receipts.length - 500);
    }
    for (const [id, waiter] of this.waiters) {
      if (
        waiter.type === receipt.type &&
        (!waiter.predicate || waiter.predicate(receipt))
      ) {
        clearTimeout(waiter.timer);
        this.waiters.delete(id);
        waiter.resolve(receipt);
      }
    }
    return receipt;
  }

  waitFor(
    type: RuntimeReceiptType,
    predicate?: (receipt: RuntimeReceipt) => boolean,
    timeoutMs = 5000
  ): Promise<RuntimeReceipt> {
    const existing = this.receipts.find(
      (receipt) => receipt.type === type && (!predicate || predicate(receipt))
    );
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`Timed out waiting for runtime receipt ${type}`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(id, {
        type,
        predicate,
        resolve,
        reject,
        timer,
      });
    });
  }

  recent(limit = 100): RuntimeReceipt[] {
    return this.receipts.slice(-Math.max(1, limit));
  }
}
