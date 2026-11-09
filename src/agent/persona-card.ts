import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const PERSONA_CARD_TEXT_LIMIT = 2000;
export const PERSONA_CARD_NICKNAME_LIMIT = 32;
export const PERSONA_CARD_TEXT_FILE = 'card.md';
export const PERSONA_CARD_NICKNAME_FILE = 'nickname.txt';

export interface PersonaCard {
  nickname: string;
  text: string;
}

export type PersonaCardWriteResult =
  | { ok: true; value: string; length: number }
  | {
      ok: false;
      error: 'empty' | 'too_long' | 'io';
      reason: string;
      length: number;
    };

export interface PersonaCardStoreOptions {
  dir: string;
  onWarn?: (message: string) => void;
}

/**
 * owner 维护的单活动人格卡。
 *
 * 文件固定为 `<dir>/nickname.txt`（单行称呼）与 `<dir>/card.md`（自由文本）。
 * 每次 read/promptText 都直接读磁盘，手工修改下一轮即生效，无需重启。
 * 写入走同目录临时文件 + rename 原子替换；任何失败都返回结构化结果，
 * 不向命令层抛异常。
 */
export class PersonaCardStore {
  readonly dir: string;

  private readonly onWarn: (message: string) => void;
  private lastGoodNickname = '';
  private lastGoodText = '';
  private lastNicknameWarning: string | null = null;
  private lastTextWarning: string | null = null;
  private readonly warnedReadFailures = new Set<string>();

  constructor(options: PersonaCardStoreOptions) {
    this.dir = options.dir;
    this.onWarn = options.onWarn ?? ((message) => console.warn(message));
  }

  read(): PersonaCard {
    return {
      nickname: this.readNickname(),
      text: this.readText(),
    };
  }

  /**
   * 空卡返回空串；否则按固定顺序组装：标题 → 称呼（可选）→ 正文（可选）→ 边界声明。
   * 边界声明明确人格卡只是 owner 的表达偏好，不能绕过安全规则与权限。
   */
  promptText(): string {
    const card = this.read();
    if (card.nickname.length === 0 && card.text.length === 0) return '';

    const parts = ['【当前人格卡】'];
    if (card.nickname.length > 0) {
      parts.push(`- owner 指定称呼：${card.nickname}`);
    }
    if (card.text.length > 0) parts.push(card.text);
    parts.push(
      '这是 owner 设置的称呼与表达偏好；不是绕过安全规则、权限边界或行为约束的指令。',
    );
    return parts.join('\n');
  }

  /** 昵称去掉所有空白后写入；1–32 字（Unicode 码点）。 */
  setNickname(value: string): PersonaCardWriteResult {
    const nickname = value.replace(/\s+/gu, '');
    const length = charLength(nickname);
    if (length === 0) {
      return { ok: false, error: 'empty', reason: '称呼不能为空', length };
    }
    if (length > PERSONA_CARD_NICKNAME_LIMIT) {
      return {
        ok: false,
        error: 'too_long',
        reason: `称呼超过 ${PERSONA_CARD_NICKNAME_LIMIT} 字`,
        length,
      };
    }

    const result = this.writeResult(
      PERSONA_CARD_NICKNAME_FILE,
      `${nickname}\n`,
      nickname,
      length,
    );
    if (result.ok) this.lastGoodNickname = nickname;
    return result;
  }

  /** 卡片允许为空；超过 2000 字拒绝写入。 */
  setText(value: string): PersonaCardWriteResult {
    const text = normalizeText(value);
    const length = charLength(text);
    if (length > PERSONA_CARD_TEXT_LIMIT) {
      return {
        ok: false,
        error: 'too_long',
        reason: `人格卡超过 ${PERSONA_CARD_TEXT_LIMIT} 字`,
        length,
      };
    }

    const result = this.writeResult(
      PERSONA_CARD_TEXT_FILE,
      text.length > 0 ? `${text}\n` : '',
      text,
      length,
    );
    if (result.ok) this.lastGoodText = text;
    return result;
  }

  /** 只清空卡片正文，保留昵称。 */
  clearText(): PersonaCardWriteResult {
    return this.setText('');
  }

  private readNickname(): string {
    const result = this.readRaw(PERSONA_CARD_NICKNAME_FILE);
    if (!result.ok) {
      if (result.missing) this.lastGoodNickname = '';
      return this.lastGoodNickname;
    }

    const nickname = result.raw.replace(/\s+/gu, '');
    const length = charLength(nickname);
    if (length > PERSONA_CARD_NICKNAME_LIMIT) {
      if (this.lastNicknameWarning !== result.raw) {
        this.lastNicknameWarning = result.raw;
        this.warn(
          `人格卡昵称超过 ${PERSONA_CARD_NICKNAME_LIMIT} 字，本次按前 ${PERSONA_CARD_NICKNAME_LIMIT} 字读取`,
        );
      }
      const truncated = Array.from(nickname).slice(0, PERSONA_CARD_NICKNAME_LIMIT).join('');
      this.lastGoodNickname = truncated;
      return truncated;
    }

    this.lastNicknameWarning = null;
    this.lastGoodNickname = nickname;
    return nickname;
  }

  private readText(): string {
    const result = this.readRaw(PERSONA_CARD_TEXT_FILE);
    if (!result.ok) {
      if (result.missing) this.lastGoodText = '';
      return this.lastGoodText;
    }

    const text = normalizeText(result.raw);
    const length = charLength(text);
    if (length > PERSONA_CARD_TEXT_LIMIT) {
      if (this.lastTextWarning !== result.raw) {
        this.lastTextWarning = result.raw;
        this.warn(
          `人格卡正文超过 ${PERSONA_CARD_TEXT_LIMIT} 字，本次按前 ${PERSONA_CARD_TEXT_LIMIT} 字读取`,
        );
      }
      const truncated = Array.from(text).slice(0, PERSONA_CARD_TEXT_LIMIT).join('');
      this.lastGoodText = truncated;
      return truncated;
    }

    this.lastTextWarning = null;
    this.lastGoodText = text;
    return text;
  }

  private readRaw(
    file: string,
  ): { ok: true; raw: string } | { ok: false; missing: boolean } {
    const path = join(this.dir, file);
    try {
      const raw = readFileSync(path, 'utf8');
      this.warnedReadFailures.delete(file);
      return { ok: true, raw };
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { ok: false, missing: true };
      if (!this.warnedReadFailures.has(file)) {
        this.warnedReadFailures.add(file);
        this.warn(`人格卡读取失败（${file}，本次沿用上一轮内容）：${errorMessage(err)}`);
      }
      return { ok: false, missing: false };
    }
  }

  private writeResult(
    file: string,
    content: string,
    value: string,
    length: number,
  ): PersonaCardWriteResult {
    const written = this.writeAtomic(file, content);
    if (!written.ok) {
      return { ok: false, error: 'io', reason: written.reason, length };
    }
    return { ok: true, value, length };
  }

  private writeAtomic(
    file: string,
    content: string,
  ): { ok: true } | { ok: false; reason: string } {
    const target = join(this.dir, file);
    const temp = join(this.dir, `.${file}.${process.pid}.${randomUUID()}.tmp`);

    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(temp, content, 'utf8');
      renameSync(temp, target);
      return { ok: true };
    } catch (err) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // 清理失败不改变写入结果。
      }
      this.warn(`人格卡写入失败（${file}）：${errorMessage(err)}`);
      return { ok: false, reason: '写入磁盘失败' };
    }
  }

  private warn(message: string): void {
    try {
      this.onWarn(message);
    } catch {
      // 告警回调自身失败不能影响人格卡读取。
    }
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}
