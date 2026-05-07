import { RuntimeReceiptBus } from './runtimeReceiptBus.js';

describe('RuntimeReceiptBus', () => {
  it('resolves waiters when a matching receipt is published', async () => {
    const bus = new RuntimeReceiptBus();

    const receiptPromise = bus.waitFor(
      'work_item.needs_review_synced',
      (receipt) => receipt.workItemId === 'work-1',
      1000
    );

    bus.publish({
      type: 'work_item.heartbeat_synced',
      workItemId: 'work-1',
    });
    const published = bus.publish({
      type: 'work_item.needs_review_synced',
      workspaceId: 'ws-1',
      workItemId: 'work-1',
      attributes: { artifactCount: 4 },
    });

    await expect(receiptPromise).resolves.toEqual(published);
  });

  it('returns already-published matching receipts immediately', async () => {
    const bus = new RuntimeReceiptBus();
    const published = bus.publish({
      type: 'checkpoint.saved',
      workspaceId: 'ws-1',
    });

    await expect(bus.waitFor('checkpoint.saved')).resolves.toEqual(published);
  });
});
