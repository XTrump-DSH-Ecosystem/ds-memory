import { describe, expect, it } from 'vitest';
import {
  mergeToolRuntimes,
  type AgentToolRuntime,
} from '../../src/agent/tool-runtime.ts';
import type { ToolSpec } from '../../src/provider/types.ts';

function runtime(
  sessionKey: string,
  tools: string[],
  budgets: { result?: number; round?: number } = {},
): AgentToolRuntime {
  const specs: ToolSpec[] = tools.map((name) => ({
    name,
    description: name,
    parameters: { type: 'object' },
  }));
  return {
    ownerSessionKey: sessionKey,
    specs,
    maxResultChars: budgets.result ?? 12_000,
    maxRoundChars: budgets.round ?? 24_000,
    beginTurn() {},
    async execute(call) {
      return { content: `${call.name}:ok` };
    },
  };
}

describe('mergeToolRuntimes', () => {
  it('合并 specs，并按工具名分发', async () => {
    const merged = mergeToolRuntimes([
      runtime('private:1', ['web_search']),
      runtime('private:1', ['memory_write']),
    ])!;

    expect(merged.specs.map((spec) => spec.name)).toEqual([
      'web_search',
      'memory_write',
    ]);
    await expect(
      merged.execute({ id: '1', name: 'memory_write', argumentsText: '{}' }),
    ).resolves.toEqual({ content: 'memory_write:ok' });
    await expect(
      merged.execute({ id: '2', name: 'unknown', argumentsText: '{}' }),
    ).resolves.toMatchObject({ error: 'unknown_tool' });
  });

  it('预算取最紧的上限，beginTurn 全部触发', () => {
    let begins = 0;
    const first = runtime('private:1', ['a'], { result: 500, round: 900 });
    const second = runtime('private:1', ['b'], { result: 800, round: 700 });
    first.beginTurn = () => { begins += 1; };
    second.beginTurn = () => { begins += 1; };

    const merged = mergeToolRuntimes([first, second])!;
    expect(merged.maxResultChars).toBe(500);
    expect(merged.maxRoundChars).toBe(700);
    merged.beginTurn();
    expect(begins).toBe(2);
  });

  it('会话不一致或工具名重复直接拒绝', () => {
    expect(() =>
      mergeToolRuntimes([
        runtime('private:1', ['a']),
        runtime('private:2', ['b']),
      ]),
    ).toThrow('会话不一致');
    expect(() =>
      mergeToolRuntimes([
        runtime('private:1', ['a']),
        runtime('private:1', ['a']),
      ]),
    ).toThrow('工具名重复');
  });
});
