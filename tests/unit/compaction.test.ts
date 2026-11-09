import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  keepRecentTurns,
  parseCompactionPayload,
  requestCompaction,
} from '../../src/agent/compaction.ts';
import {
  ProviderAbortError,
  type ChatEvent,
  type ChatEventStream,
  type ChatMessage,
  type Provider,
} from '../../src/provider/types.ts';

function fakeProvider(text: string): Provider {
  return {
    id: 'deepseek',
    chat(): ChatEventStream {
      return (async function* (): AsyncGenerator<ChatEvent> {
        yield { type: 'text', text };
        yield { type: 'done' };
      })();
    },
    usageOf(event) {
      return event.type === 'usage' ? event.usage : null;
    },
    async health() {
      return { ok: true, detail: 'fake' };
    },
  };
}

describe('estimateTokens', () => {
  it('字符数 ÷ 1.5 的近似值', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: '一'.repeat(50) },
      { role: 'user', content: '二'.repeat(100) },
    ];
    expect(estimateTokens(messages)).toBe(100);
  });
});

describe('parseCompactionPayload', () => {
  it('解析合法 JSON', () => {
    const payload = parseCompactionPayload(
      '{"facts":[{"text":"他不吃香菜","tag":"preference"}],"selfNotes":["我该更简短"],"summary":"聊了忌口"}',
    );

    expect(payload).not.toBeNull();
    expect(payload!.facts[0]).toEqual({ text: '他不吃香菜', tag: 'preference' });
    expect(payload!.selfNotes).toEqual(['我该更简短']);
    expect(payload!.summary).toBe('聊了忌口');
  });

  it('容忍 ```json 代码块与前后解释文字', () => {
    const payload = parseCompactionPayload(
      '好的，下面是整理结果：\n```json\n{"facts":[],"selfNotes":[],"summary":"摘要"}\n```\n完毕',
    );
    expect(payload?.summary).toBe('摘要');
  });

  it('缺 summary 视为不合法（本次放弃压缩）', () => {
    expect(parseCompactionPayload('{"facts":[],"selfNotes":[]}')).toBeNull();
  });

  it('完全不是 JSON 时返回 null', () => {
    expect(parseCompactionPayload('我觉得这段对话很重要')).toBeNull();
  });

  it('非法 tag 回退 misc，selfNotes 最多 2 条，文本截断', () => {
    const payload = parseCompactionPayload(
      JSON.stringify({
        facts: [{ text: 'x'.repeat(200), tag: 'unknown' }],
        selfNotes: ['a', 'b', 'c'],
        summary: 'short',
      }),
    )!;

    expect(payload.facts[0]!.tag).toBe('misc');
    expect(Array.from(payload.facts[0]!.text).length).toBeLessThanOrEqual(140);
    expect(payload.selfNotes).toHaveLength(2);
  });
});

describe('keepRecentTurns', () => {
  it('只保留最近 2 轮（4 条消息）', () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_value, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `m${index}`,
    }));
    expect(keepRecentTurns(history).map((m) => m.content)).toEqual(['m6', 'm7', 'm8', 'm9']);
  });
});

describe('requestCompaction', () => {
  it('整理轮成功时返回解析后的 payload', async () => {
    const provider = fakeProvider(
      '{"facts":[{"text":"住杭州","tag":"identity"}],"selfNotes":[],"summary":"聊了住址"}',
    );

    const result = await requestCompaction({
      provider,
      sessionKey: 'cli:test',
      staticPrompt: 'SYS',
      history: [{ role: 'user', content: '我住杭州' }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.summary).toBe('聊了住址');
  });

  it('整理轮输出不合法时 ok:false', async () => {
    const provider = fakeProvider('我不想输出 JSON');
    const result = await requestCompaction({
      provider,
      sessionKey: 'cli:test',
      staticPrompt: 'SYS',
      history: [{ role: 'user', content: '随便聊聊' }],
    });

    expect(result.ok).toBe(false);
  });

  it('外部 signal 已中断时不调用 provider，直接返回 ok:false', async () => {
    let calls = 0;
    const provider: Provider = {
      id: 'deepseek',
      chat(): ChatEventStream {
        calls += 1;
        return (async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'done' };
        })();
      },
      usageOf(event) {
        return event.type === 'usage' ? event.usage : null;
      },
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };
    const controller = new AbortController();
    controller.abort();

    const result = await requestCompaction({
      provider,
      sessionKey: 'cli:test',
      staticPrompt: 'SYS',
      history: [{ role: 'user', content: '不会发出去的对话' }],
      signal: controller.signal,
    });

    expect(result).toEqual({ ok: false, reason: '整理已中断' });
    expect(calls).toBe(0);
  });

  it('外部中断会传到 provider，并快速返回 ok:false', async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let receivedSignal: AbortSignal | null = null;
    const provider: Provider = {
      id: 'deepseek',
      chat(_request, opts): ChatEventStream {
        receivedSignal = opts.signal;
        return (async function* (): AsyncGenerator<ChatEvent> {
          yield { type: 'text', text: '{"facts":[],"selfNotes":[],"summary":"不应写入"}' };
          markStarted();
          await new Promise<void>((resolve) => {
            if (opts.signal.aborted) {
              resolve();
              return;
            }
            opts.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new ProviderAbortError();
        })();
      },
      usageOf(event) {
        return event.type === 'usage' ? event.usage : null;
      },
      async health() {
        return { ok: true, detail: 'fake' };
      },
    };

    const pending = requestCompaction({
      provider,
      sessionKey: 'cli:test',
      staticPrompt: 'SYS',
      history: [{ role: 'user', content: '需要中断的对话' }],
      signal: controller.signal,
    });
    await started;

    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal!.aborted).toBe(false);
    controller.abort();
    expect(receivedSignal!.aborted).toBe(true);

    await expect(pending).resolves.toEqual({ ok: false, reason: '整理已中断' });
  }, 1_000);
});
