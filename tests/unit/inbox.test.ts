import { describe, expect, it } from 'vitest';
import { SessionInbox } from '../../src/qq/inbox.ts';
import type { InboxItem } from '../../src/qq/types.ts';

function item(
  eventId: string,
  sessionKey = 'private:1',
  receivedAt = 0,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  return {
    eventId,
    sessionKey,
    kind: sessionKey.startsWith('group:') ? 'group' : 'private',
    speaker: null,
    text: `消息 ${eventId}`,
    quote: null,
    isAtBot: false,
    receivedAt,
    ...overrides,
  };
}

describe('SessionInbox', () => {
  it('按会话 FIFO 入队并整批取出，取出后置忙', () => {
    const inbox = new SessionInbox();
    inbox.enqueue(item('m1', 'private:1', 1));
    inbox.enqueue(item('m2', 'private:1', 2));
    inbox.enqueue(item('m3', 'private:1', 3));
    inbox.enqueue(item('g1', 'group:9', 4));

    expect(inbox.size('private:1')).toBe(3);
    expect(inbox.isBusy('private:1')).toBe(false);

    const batch = inbox.takeNextBatch('private:1');

    expect(batch?.map((entry) => entry.eventId)).toEqual(['m1', 'm2', 'm3']);
    expect(inbox.size('private:1')).toBe(0);
    expect(inbox.isBusy('private:1')).toBe(true);
    expect(inbox.takeNextBatch('private:1')).toBeNull();
    expect(inbox.size('group:9')).toBe(1);
  });

  it('忙时同一会话继续排队，release 后再串行取下一批', () => {
    const inbox = new SessionInbox();
    inbox.enqueue(item('m1', 'private:1', 1));

    expect(inbox.takeNextBatch('private:1')?.map((entry) => entry.eventId)).toEqual(['m1']);

    inbox.enqueue(item('m2', 'private:1', 2));
    inbox.enqueue(item('m3', 'private:1', 3));

    expect(inbox.takeNextBatch('private:1')).toBeNull();
    expect(inbox.size('private:1')).toBe(2);

    inbox.release('private:1');
    expect(inbox.isBusy('private:1')).toBe(false);
    expect(inbox.takeNextBatch('private:1')?.map((entry) => entry.eventId)).toEqual(['m2', 'm3']);
    expect(inbox.isBusy('private:1')).toBe(true);
  });

  it('不同会话互不阻塞：一个会话忙时另一个仍可取批', () => {
    const inbox = new SessionInbox();
    inbox.enqueue(item('a1', 'private:1', 1));
    inbox.enqueue(item('b1', 'private:2', 2));

    const first = inbox.takeNextBatch('private:1');
    const second = inbox.takeNextBatch('private:2');

    expect(first?.map((entry) => entry.eventId)).toEqual(['a1']);
    expect(second?.map((entry) => entry.eventId)).toEqual(['b1']);
    expect(inbox.isBusy('private:1')).toBe(true);
    expect(inbox.isBusy('private:2')).toBe(true);
    expect(inbox.busySessionsSnapshot().sort()).toEqual(['private:1', 'private:2']);
  });

  it('空闲但无消息时取批返回 null，且不会置忙', () => {
    const inbox = new SessionInbox();

    expect(inbox.takeNextBatch('private:1')).toBeNull();
    expect(inbox.isBusy('private:1')).toBe(false);
  });

  it('maxItems 只取本批上限内条目，其余留在队首', () => {
    const inbox = new SessionInbox();
    inbox.enqueue(item('m1', 'private:1', 1));
    inbox.enqueue(item('m2', 'private:1', 2));
    inbox.enqueue(item('m3', 'private:1', 3));

    expect(inbox.takeNextBatch('private:1', 2)?.map((entry) => entry.eventId)).toEqual(['m1', 'm2']);
    expect(inbox.size('private:1')).toBe(1);

    inbox.release('private:1');
    expect(inbox.takeNextBatch('private:1')?.map((entry) => entry.eventId)).toEqual(['m3']);
  });

  it('requeueFront 把溢出条目放回队首，新消息排在其后', () => {
    const inbox = new SessionInbox();
    inbox.enqueue(item('m1', 'private:1', 1));
    inbox.enqueue(item('m2', 'private:1', 2));

    const batch = inbox.takeNextBatch('private:1') ?? [];
    inbox.enqueue(item('m3', 'private:1', 3));
    inbox.requeueFront('private:1', batch.slice(1));
    inbox.release('private:1');

    expect(inbox.takeNextBatch('private:1')?.map((entry) => entry.eventId)).toEqual(['m2', 'm3']);
  });

  it('requeueFront 拒绝其他会话的条目', () => {
    const inbox = new SessionInbox();

    expect(() => inbox.requeueFront('private:1', [item('x', 'private:2')])).toThrow(
      /其他会话/,
    );
  });
});
