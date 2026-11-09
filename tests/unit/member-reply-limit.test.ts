import { describe, expect, it } from 'vitest';
import { MemberReplyLimiter } from '../../src/qq/member-reply-limit.ts';

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('MemberReplyLimiter', () => {
  it('相邻成员回复等待到 3 秒间隔', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new MemberReplyLimiter({
      minIntervalMs: 3_000,
      maxPerMinute: 6,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    expect(await limiter.acquire('group:1', signal())).toBe(true);
    now = 1_200;
    expect(await limiter.acquire('group:1', signal())).toBe(true);

    expect(sleeps).toEqual([1_800]);
    expect(now).toBe(3_000);
  });

  it('60 秒窗口最多 6 次，窗口滑出后恢复', async () => {
    let now = 0;
    const limiter = new MemberReplyLimiter({
      minIntervalMs: 0,
      maxPerMinute: 6,
      now: () => now,
      sleep: async () => undefined,
    });

    for (let index = 0; index < 6; index += 1) {
      expect(await limiter.acquire('group:1', signal())).toBe(true);
    }
    expect(limiter.canStart('group:1')).toBe(false);
    expect(await limiter.acquire('group:1', signal())).toBe(false);

    now = 60_000;
    expect(limiter.canStart('group:1')).toBe(true);
    expect(await limiter.acquire('group:1', signal())).toBe(true);
  });

  it('不同群会话配额相互独立', async () => {
    const limiter = new MemberReplyLimiter({
      minIntervalMs: 0,
      maxPerMinute: 1,
      now: () => 0,
      sleep: async () => undefined,
    });

    expect(await limiter.acquire('group:1', signal())).toBe(true);
    expect(await limiter.acquire('group:1', signal())).toBe(false);
    expect(await limiter.acquire('group:2', signal())).toBe(true);
  });
});
