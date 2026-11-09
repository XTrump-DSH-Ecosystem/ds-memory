import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent/loop.ts';
import {
  PERSONA_CARD_NICKNAME_LIMIT,
  PERSONA_CARD_TEXT_LIMIT,
  PersonaCardStore,
} from './agent/persona-card.ts';
import { BUILTIN_PERSONA } from './agent/prompt.ts';
import { ConfigError, loadConfig } from './config/load.ts';
import { FactsStore } from './memory/facts.ts';
import { createRetriever } from './memory/retriever/index.ts';
import { formatInjection } from './memory/retriever/types.ts';
import { isNicknamePreferenceText, SelfNoteStore } from './memory/selfnote.ts';
import { EventStore } from './memory/store.ts';
import { createProvider } from './provider/index.ts';
import { ProviderAbortError, ProviderError } from './provider/types.ts';
import { startQqService } from './qq/service.ts';
import {
  memoryEventsDir,
  memoryFactsDir,
  memorySelfNotesDir,
  personaCardDir,
  sessionsDir,
} from './state/paths.ts';
import { describeError, redactPaths } from './util/redact.ts';
import { error as logError, info, warn } from './util/log.ts';
import { normalizeCommandPrefix } from './util/string.ts';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_ROOT = resolve(process.env.DS_MEMORY_CONFIG_ROOT ?? PROJECT_ROOT);
const SESSION_KEY = 'cli:owner';

async function main(): Promise<void> {
  // .env 只在本地读取；npm run dev 也带了 --env-file-if-exists，两条路径都兼容。
  try {
    process.loadEnvFile(resolve(PROJECT_ROOT, '.env'));
  } catch {
    // 没有 .env 是正常情况，缺 key 时 provider 会给出明确提示。
  }

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(CONFIG_ROOT);
  } catch (err) {
    logError(err instanceof ConfigError ? err.message : describeError(err));
    process.exitCode = 1;
    return;
  }

  const { config, source } = loaded;
  if (source === 'config.example.jsonc') {
    warn('未找到 config.jsonc，正在使用 config.example.jsonc（建议复制一份再改）');
  }

  const persona = readPersona();

  if (process.argv.slice(2).includes('--serve')) {
    await runServe(config, persona.text);
    return;
  }

  const cliWarn = (message: string): void => warn(redactPaths(message));
  const provider = createProvider(config.provider);
  const store = new EventStore({
    dir: memoryEventsDir(config.stateDir),
    onWarn: cliWarn,
  });
  const facts = new FactsStore({
    dir: memoryFactsDir(config.stateDir),
    halfLifeDays: config.memory.facts.halfLifeDays,
    archiveThreshold: config.memory.facts.archiveThreshold,
    injectMax: config.memory.facts.injectMax,
    injectMaxChars: config.memory.facts.injectMaxChars,
    autoReviewEnabled: config.memory.facts.autoReview,
    onWarn: cliWarn,
  });
  const selfNotes = new SelfNoteStore({
    dir: memorySelfNotesDir(config.stateDir),
    max: config.memory.selfNote.max,
    bootstrapLimit: config.memory.selfNote.bootstrapLimit,
    onWarn: cliWarn,
  });
  const personaCard = new PersonaCardStore({
    dir: personaCardDir(config.stateDir),
    onWarn: cliWarn,
  });
  const retriever = createRetriever({
    store,
    recall: config.memory.recall,
    onWarn: cliWarn,
    onInfo: (message) => info(message),
  });

  const agent = new Agent({
    provider,
    store,
    persona: persona.text,
    personaCard: personaCard.promptText(),
    reloadPersonaCard: () => personaCard.promptText(),
    sessionKey: SESSION_KEY,
    src: 'cli',
    memory: {
      facts,
      selfNotes,
      retriever,
      recall: config.memory.recall,
    },
    compaction: {
      enabled: config.agent.compaction.enabled,
      idleMs: config.agent.compaction.idleMs,
      thresholdTokens: config.agent.compaction.thresholdTokens,
      minTurns: config.agent.compaction.minTurns,
      sessionStateDir: sessionsDir(config.stateDir),
    },
    onWarn: cliWarn,
    onInfo: (message) => info(message),
  });

  banner(config, persona.fromFile);

  const health = await provider.health();
  if (!health.ok) warn(health.detail);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
    crlfDelay: Infinity,
  });

  let buffer = '';
  let busy = false;
  let activeAbort: AbortController | null = null;
  let closed = false;

  const prompt = (): void => {
    if (closed) return;
    rl.setPrompt(buffer.length > 0 ? '... ' : '你 > ');
    rl.prompt();
  };

  /**
   * 记忆命令（CLI 命令层，Agent 不感知）：
   * !记 <一句话> → facts.upsert(...,'misc')
   * !note <一句话> → selfNote 写入
   * !回忆 <关键词> → 检索并打印带出处的记忆
   * !人格 [文本|清空] → 查看/设置/清空人格卡
   * !称呼 <称呼> → 设置人格卡昵称
   */
  const handleMemoryCommand = async (command: string): Promise<void> => {
    const personaMatch = /^!人格(?:\s+([\s\S]*))?$/.exec(command);
    if (personaMatch) {
      const body = (personaMatch[1] ?? '').trim();
      if (body.length === 0) {
        const card = personaCard.read();
        if (card.nickname.length === 0 && card.text.length === 0) {
          warn('用法：!人格（查看）/ !人格 <文本> / !人格 清空');
        } else {
          info(
            [
              '当前人格卡：',
              `称呼：${card.nickname.length > 0 ? card.nickname : '（未设置）'}`,
              '卡片：',
              card.text.length > 0 ? card.text : '（空）',
            ].join('\n'),
          );
        }
      } else if (body === '清空') {
        const result = personaCard.clearText();
        if (result.ok) {
          agent.refreshPersonaCard();
          info('人格卡已清空（称呼保留）；下一轮生效。');
        } else {
          warn(`人格卡清空失败（未更新）：${result.reason}`);
        }
      } else {
        const result = personaCard.setText(body);
        if (result.ok) {
          agent.refreshPersonaCard();
          info(`人格卡已更新（${result.length} 字）；下一轮生效。`);
        } else if (result.error === 'too_long') {
          warn(
            `人格卡过长：最多 ${PERSONA_CARD_TEXT_LIMIT} 字（当前 ${result.length} 字）`,
          );
        } else {
          warn(`人格卡写入失败（未更新）：${result.reason}`);
        }
      }
      prompt();
      return;
    }

    const nicknameMatch = /^!称呼(?:\s+([\s\S]*))?$/.exec(command);
    if (nicknameMatch) {
      const result = personaCard.setNickname((nicknameMatch[1] ?? '').trim());
      if (result.ok) {
        const archived = selfNotes.archiveMatching(SESSION_KEY, (record) =>
          isNicknamePreferenceText(record.text),
        );
        agent.refreshPersonaCard();
        info(
          `已设置称呼「${result.value}」；下一轮生效。归档旧称呼偏好 ${archived} 条。`,
        );
      } else if (result.error === 'empty') {
        warn('用法：!称呼 <称呼>');
      } else if (result.error === 'too_long') {
        warn(
          `称呼过长：最多 ${PERSONA_CARD_NICKNAME_LIMIT} 字（当前 ${result.length} 字）`,
        );
      } else {
        warn(`称呼写入失败（人格卡未更新）：${result.reason}`);
      }
      prompt();
      return;
    }

    if (command.startsWith('!记')) {
      const text = command.slice(2).trim();
      if (text.length === 0) {
        warn('用法：!记 <一句话>');
        prompt();
        return;
      }
      const result = facts.upsert(SESSION_KEY, text, 'misc');
      if (result) {
        info(`${result.created ? '已记住' : '复习一次'}：${result.record.text}`);
      } else {
        warn('事实写入失败（历史记录未落盘）');
      }
      prompt();
      return;
    }

    if (command.startsWith('!note')) {
      const text = command.slice(5).trim();
      if (text.length === 0) {
        warn('用法：!note <一句话>');
        prompt();
        return;
      }
      const note = selfNotes.upsert(SESSION_KEY, text);
      if (note) {
        agent.refreshSelfNote();
        info(`已写下自认知：${note.text}`);
      } else {
        warn('selfNote 写入失败');
      }
      prompt();
      return;
    }

    if (command.startsWith('!回忆')) {
      const query = command.slice(3).trim();
      if (query.length === 0) {
        warn('用法：!回忆 <关键词>');
        prompt();
        return;
      }
      busy = true;
      try {
        const hits = await retriever.search(query, {
          sessionKey: SESSION_KEY,
          limit: config.memory.recall.budgetItems,
        });
        if (hits.length === 0) {
          info('没有检索到相关记忆。');
        } else {
          console.log(formatInjection(hits));
        }
      } finally {
        busy = false;
        prompt();
      }
      return;
    }

    if (command.startsWith('!整理')) {
      const extra = command.slice(3).trim();
      if (extra.length > 0) {
        warn('用法：!整理（不需要参数）');
        prompt();
        return;
      }
      busy = true;
      const abort = new AbortController();
      activeAbort = abort;
      try {
        const result = await agent.consolidateNow({ signal: abort.signal });
        if (result.ok) {
          info(
            `整理完成：事实 ${result.facts ?? 0} 条，自认知 ${result.selfNotes ?? 0} 条，摘要已更新`,
          );
        } else if (abort.signal.aborted) {
          info('整理已中断');
        } else {
          warn(`整理未完成：${result.reason ?? '未知原因'}`);
        }
      } catch (err) {
        if (abort.signal.aborted) {
          info('整理已中断');
        } else {
          logError(`整理失败：${describeError(err)}`);
        }
      } finally {
        activeAbort = null;
        busy = false;
        prompt();
      }
      return;
    }

    warn(`未知命令：${command}（可用 !记 / !note / !回忆 / !整理 / !人格 / !称呼）`);
    prompt();
  };

  const handleCommand = (command: string): void => {
    if (command.startsWith('!')) {
      void handleMemoryCommand(command);
      return;
    }

    switch (command) {
      case '/exit':
      case '/quit':
        info('再见。');
        closed = true;
        rl.close();
        return;
      case '/clear':
        process.stdout.write('\x1b[2J\x1b[H');
        prompt();
        return;
      case '/status':
        printStatus(config, persona.fromFile, agent);
        prompt();
        return;
      case '/help':
        printHelp();
        prompt();
        return;
      default:
        warn(`未知命令：${command}（可用 /status /clear /exit）`);
        prompt();
    }
  };

  const sendTurn = async (text: string): Promise<void> => {
    busy = true;
    const abort = new AbortController();
    activeAbort = abort;
    let wroteText = false;

    try {
      const result = await agent.runTurn(text, {
        signal: abort.signal,
        onText: (chunk) => {
          wroteText = true;
          process.stdout.write(chunk);
        },
      });
      if (wroteText) process.stdout.write('\n');
      if (result.interrupted) info('本轮已中断');
    } catch (err) {
      if (wroteText) process.stdout.write('\n');
      if (err instanceof ProviderAbortError) {
        info('本轮已中断');
      } else if (err instanceof ProviderError) {
        logError(`模型调用失败：${err.message}`);
      } else {
        logError(`未预期错误：${describeError(err)}`);
      }
    } finally {
      busy = false;
      activeAbort = null;
      prompt();
    }
  };

  rl.on('line', (line) => {
    if (closed || busy) return;

    const raw = line.replace(/\r$/, '');

    if (buffer.length === 0) {
      const trimmed = raw.trim();
      if (trimmed === '') {
        prompt();
        return;
      }
      const command = normalizeCommandPrefix(trimmed);
      if (command.startsWith('/') || command.startsWith('!')) {
        handleCommand(command);
        return;
      }
    }

    // 行尾 \ 表示续行；缓冲区非空时，空行发送整段多行消息。
    if (raw.endsWith('\\')) {
      buffer += `${raw.slice(0, -1)}\n`;
      prompt();
      return;
    }

    if (buffer.length > 0) {
      if (raw.trim() === '') {
        const text = buffer.trimEnd();
        buffer = '';
        void sendTurn(text);
        return;
      }
      buffer += `${raw}\n`;
      prompt();
      return;
    }

    void sendTurn(raw);
  });

  rl.on('SIGINT', () => {
    if (activeAbort) {
      activeAbort.abort();
      return;
    }
    console.log('\n再见。');
    closed = true;
    rl.close();
  });

  rl.on('close', () => {
    closed = true;
    process.exitCode ??= 0;
  });

  prompt();
}

async function runServe(
  config: ReturnType<typeof loadConfig>['config'],
  persona: string,
): Promise<void> {
  if (!config.qq.enabled) {
    logError('serve 模式需要 qq.enabled=true');
    process.exitCode = 1;
    return;
  }

  const service = await startQqService({ config, persona });
  info(`QQ serve 已启动：hookPort=${service.port}`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    info(`收到 ${signal}，正在关闭 QQ 服务`);
    try {
      await service.stop();
    } catch (err) {
      logError(`QQ 服务关闭失败：${describeError(err)}`);
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

function readPersona(): { text: string; fromFile: boolean } {
  const path = resolve(PROJECT_ROOT, 'persona.md');
  if (existsSync(path)) {
    return { text: readFileSync(path, 'utf8'), fromFile: true };
  }
  return { text: BUILTIN_PERSONA, fromFile: false };
}

function banner(config: ReturnType<typeof loadConfig>['config'], personaFromFile: boolean): void {
  const providerName = config.provider.default;
  const model = providerName === 'deepseek' ? ` (${config.provider.deepseek.model})` : '';
  console.log('');
  console.log('  小鲸鱼 · xds-memory · P1');
  console.log(`  provider : ${providerName}${model}`);
  console.log(`  recall   : ${config.memory.recall.engine === 'embedding' ? 'BGE 语义 + bigram 证据门（失败自动回退）' : 'bigram'}`);
  console.log(`  state    : ${config.stateDir}`);
  console.log(`  persona  : ${personaFromFile ? 'persona.md' : '内置兜底（未找到 persona.md）'}`);
  console.log('  命令     : /status /clear /exit；!记 / !note / !回忆 / !整理 / !人格 / !称呼；行尾 \\ 续行，空行发送多行');
  console.log('');
}

function printHelp(): void {
  console.log('  /status  查看 provider、状态目录、记忆计数与 token 累计');
  console.log('  /clear   清屏（不影响已落盘历史）');
  console.log('  /exit    退出');
  console.log('  !记      !记 <一句话>，写进长期记忆（重启后仍会注入）');
  console.log('  !note    !note <一句话>，写下一条自认知（下一轮起注入）');
  console.log('  !回忆    !回忆 <关键词>，检索 L0 原文并打印出处');
  console.log('  !整理    立即整理当前上下文，写出 facts/selfNote 并更新摘要');
  console.log('  !人格    !人格 查看；!人格 <文本> 设置；!人格 清空 只清正文（下一轮生效）');
  console.log('  !称呼    !称呼 <称呼>，设置人格卡称呼（1–32 字，下一轮生效）');
  console.log('  行尾 \\   多行输入；缓冲区里再敲一次空行发送');
}

function printStatus(
  config: ReturnType<typeof loadConfig>['config'],
  personaFromFile: boolean,
  agent: Agent,
): void {
  const usage = agent.usageTotals;
  const baseUrl = config.provider.default === 'deepseek' ? config.provider.deepseek.baseUrl : '-';
  console.log('  当前状态');
  console.log(`    provider    : ${config.provider.default}${config.provider.default === 'deepseek' ? ` (${config.provider.deepseek.model})` : ''}`);
  console.log(`    baseUrl     : ${baseUrl}`);
  console.log(`    stateDir    : ${config.stateDir}`);
  console.log(`    session     : ${SESSION_KEY}`);
  console.log(`    persona     : ${personaFromFile ? 'persona.md' : '内置兜底'}`);
  console.log(`    context     : ${agent.historyMessageCount} 条消息（上限 20 轮）`);
  console.log(`    facts       : ${agent.factsCount} 条（注入预算 ${config.memory.facts.injectMax} 条 / ${config.memory.facts.injectMaxChars} 字）`);
  console.log(`    selfNotes   : ${agent.selfNoteCount} 条（上限 ${config.memory.selfNote.max}）`);
  console.log(`    summary     : ${agent.hasSummary ? '有（压缩过的旧对话）' : '无'}`);
  console.log(`    recall      : ${config.memory.recall.trigger === 'auto' ? '自动（命中回忆词才检索）' : '关闭（仅 !回忆 可用）'}`);
  console.log(`    engine      : ${config.memory.recall.engine === 'embedding' ? `embedding → ${config.memory.recall.embedding.modelDir}` : 'bigram'}`);
  console.log(`    tokens      : 输入 ${usage.promptTokens} / 输出 ${usage.completionTokens} / 合计 ${usage.totalTokens}`);
}

main().catch((err) => {
  logError(redactPaths(`启动失败：${describeError(err)}`));
  process.exitCode = 1;
});
