import { describe, expect, it } from 'vitest';
import {
  CODE_SESSIONS_QUERY_MAX_CHARS,
  CODE_TASK_MAX_CHARS,
  isCodeCommandText,
  parseCodeCommand,
} from '../../src/code-tasks/parser.ts';

describe('isCodeCommandText', () => {
  it.each([
    ['code', true],
    ['code ', true],
    ['code\ttask', true],
    ['code\ntask', true],
    ['code\r\ntask', true],
    ['codex', false],
    ['Code', false],
    [' code ds-memory', false],
    ['\tcode ds-memory', false],
    ['code\u00a0ds-memory', false],
    ['', false],
  ])('%j => %s', (text, expected) => {
    expect(isCodeCommandText(text)).toBe(expected);
  });
});

describe('parseCodeCommand', () => {
  it('解析空格分隔的提交并保留任务内部空格', () => {
    expect(parseCodeCommand('code ds-memory  修 复   parser')).toEqual({
      kind: 'submit',
      repo: 'ds-memory',
      task: '修 复   parser',
    });
  });

  it('解析 repo 后换行与多行任务，仅 trim 外缘', () => {
    expect(parseCodeCommand('code qq-gateway\n  第一行\n  第二行  ')).toEqual({
      kind: 'submit',
      repo: 'qq-gateway',
      task: '第一行\n  第二行',
    });
  });

  it('解析 code 后换行再给 repo 与任务', () => {
    expect(parseCodeCommand('code\nxtds\t做一件事')).toEqual({
      kind: 'submit',
      repo: 'xtds',
      task: '做一件事',
    });
  });

  it('容忍 CRLF 与制表符分隔', () => {
    expect(
      parseCodeCommand('code\r\nxtds-assistant-dsh\t第一行\r\n第二行'),
    ).toEqual({
      kind: 'submit',
      repo: 'xtds-assistant-dsh',
      task: '第一行\r\n第二行',
    });
  });

  it('接受 martilyric repo', () => {
    expect(parseCodeCommand('code martilyric 检查项目')).toEqual({
      kind: 'submit',
      repo: 'martilyric',
      task: '检查项目',
    });
  });

  it('解析 status 与 cancel', () => {
    expect(parseCodeCommand('code status')).toEqual({ kind: 'status' });
    expect(parseCodeCommand('code status\r\n')).toEqual({ kind: 'status' });
    expect(parseCodeCommand('code cancel task-123   ')).toEqual({
      kind: 'cancel',
      taskId: 'task-123',
    });
  });

  it.each([
    ['code', 'missing_repo'],
    ['code   ', 'missing_repo'],
    ['code unknown-repo task', 'unknown_repo'],
    ['code ds-memory', 'empty_task'],
    ['code ds-memory   \n  ', 'empty_task'],
    ['code cancel', 'missing_task_id'],
    ['code cancel task 1', 'missing_task_id'],
    ['Code ds-memory task', 'not_code'],
    ['codex ds-memory task', 'not_code'],
    [' code ds-memory task', 'not_code'],
  ])('%j 返回 usage(%s)', (text, reason) => {
    expect(parseCodeCommand(text)).toEqual({ kind: 'usage', reason });
  });

  it('任务长度按 Unicode code point 计算，4000 接受、4001 拒绝', () => {
    const task4000 = '😀'.repeat(CODE_TASK_MAX_CHARS);
    expect(parseCodeCommand(`code xtds ${task4000}`)).toMatchObject({
      kind: 'submit',
      repo: 'xtds',
      task: task4000,
    });

    expect(parseCodeCommand(`code xtds ${task4000}😀`)).toEqual({
      kind: 'usage',
      reason: 'task_too_long',
    });
  });

  it('解析 code sessions：query 可空、保留内部空格、sessions 不会被当成 repo', () => {
    expect(parseCodeCommand('code sessions')).toEqual({
      kind: 'sessions',
      query: '',
    });
    expect(parseCodeCommand('code sessions\r\n')).toEqual({
      kind: 'sessions',
      query: '',
    });
    expect(parseCodeCommand('code   sessions   ds-memory 修复  ')).toEqual({
      kind: 'sessions',
      query: 'ds-memory 修复',
    });
    expect(parseCodeCommand('code sessions ds-memory')).toEqual({
      kind: 'sessions',
      query: 'ds-memory',
    });
    expect(parseCodeCommand('code ds-memory sessions 修复')).toEqual({
      kind: 'submit',
      repo: 'ds-memory',
      task: 'sessions 修复',
    });
  });

  it('code sessions query 按 code point 限制 100 字且必须单行', () => {
    const query100 = '😀'.repeat(CODE_SESSIONS_QUERY_MAX_CHARS);
    expect(parseCodeCommand(`code sessions ${query100}`)).toEqual({
      kind: 'sessions',
      query: query100,
    });
    expect(parseCodeCommand(`code sessions ${query100}😀`)).toEqual({
      kind: 'usage',
      reason: 'sessions_query_too_long',
    });
    expect(parseCodeCommand('code sessions 第一行\n第二行')).toEqual({
      kind: 'usage',
      reason: 'sessions_query_multiline',
    });
  });
});
