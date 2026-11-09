import type { InboxItem } from './types.ts';

/**
 * 每会话 FIFO 收件箱 + 忙状态串行闸门。
 *
 * - 入队只追加，不合并、不丢原文；
 * - `takeNextBatch` 只有在该会话空闲时才会成功，并立即置忙；
 * - 不同 session 使用独立队列与忙标记，互不阻塞；
 * - 处理完成（无论成功失败）必须调用 `release` 释放闸门。
 */
export class SessionInbox {
  private readonly queues = new Map<string, InboxItem[]>();
  private readonly busySessions = new Set<string>();

  /** 追加到会话队尾；arrival 顺序即 FIFO 顺序。 */
  enqueue(item: InboxItem): void {
    const queue = this.queues.get(item.sessionKey);
    if (queue) {
      queue.push(item);
      return;
    }
    this.queues.set(item.sessionKey, [item]);
  }

  /** 该会话尚未被取出的消息数。 */
  size(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length ?? 0;
  }

  /** 该会话是否正在处理（已被取批且尚未 release）。 */
  isBusy(sessionKey: string): boolean {
    return this.busySessions.has(sessionKey);
  }

  /** 当前正在处理的会话列表（用于观测/测试）。 */
  busySessionsSnapshot(): string[] {
    return [...this.busySessions];
  }

  /** 当前仍有排队消息的会话列表（用于调度）。 */
  pendingSessions(): string[] {
    return [...this.queues.keys()];
  }

  /**
   * 取出下一批：会话空闲且队列非空时，按 FIFO 取至多 `maxItems` 条并置忙。
   * 忙时返回 null（消息继续排队），不会并行处理同一会话。
   */
  takeNextBatch(sessionKey: string, maxItems: number = Number.POSITIVE_INFINITY): InboxItem[] | null {
    if (this.busySessions.has(sessionKey)) return null;

    const queue = this.queues.get(sessionKey);
    if (!queue || queue.length === 0) return null;

    const limit = Number.isFinite(maxItems)
      ? Math.max(1, Math.floor(maxItems))
      : queue.length;
    const count = Math.min(queue.length, limit);
    const batch = queue.splice(0, count);
    if (queue.length === 0) this.queues.delete(sessionKey);

    this.busySessions.add(sessionKey);
    return batch;
  }

  /**
   * 把本批未消费的条目按原序放回队首（合批字符/条数上限溢出时使用）。
   * 新入队但尚未取出的消息排在这些条目之后，保持 FIFO。
   */
  requeueFront(sessionKey: string, items: readonly InboxItem[]): void {
    if (items.length === 0) return;

    for (const item of items) {
      if (item.sessionKey !== sessionKey) {
        throw new Error(`requeueFront 收到其他会话的条目：${item.sessionKey}`);
      }
    }

    const queue = this.queues.get(sessionKey) ?? [];
    this.queues.set(sessionKey, [...items, ...queue]);
  }

  /** 处理结束，释放该会话的串行闸门。 */
  release(sessionKey: string): void {
    this.busySessions.delete(sessionKey);
  }
}
