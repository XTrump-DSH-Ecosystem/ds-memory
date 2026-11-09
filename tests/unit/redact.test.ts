import { afterEach, describe, expect, it } from 'vitest';
import { describeError, redact, redactPaths } from '../../src/util/redact.ts';

const ENV_NAME = 'XDS_TEST_SECRET_KEY';
const ENV_VALUE = 'super-secret-value-123';

afterEach(() => {
  delete process.env[ENV_NAME];
});

describe('redact', () => {
  it('按环境变量名替换密钥值', () => {
    process.env[ENV_NAME] = ENV_VALUE;
    expect(redact(`key=${ENV_VALUE}`)).toBe('key=[REDACTED]');
  });

  it('兜底替换 sk- 形态的 token', () => {
    const output = redact('Authorization: sk-abc123456789xyz');
    expect(output).not.toContain('abc123456789xyz');
    expect(output).toContain('[REDACTED]');
  });

  it('兜底替换 Bearer token', () => {
    expect(redact('header Bearer abcdefghijklmnop')).toBe('header Bearer [REDACTED]');
  });

  it('保持原有行为：redact() 不隐式脱敏路径', () => {
    expect(redact('open C:\\tmp\\x.jsonl')).toBe('open C:\\tmp\\x.jsonl');
    expect(describeError(new Error('open C:\\tmp\\x.jsonl'))).toBe('open C:\\tmp\\x.jsonl');
  });
});

describe('redactPaths', () => {
  it('覆盖 Windows 盘符绝对路径（反斜杠与正斜杠）', () => {
    expect(
      redactPaths('日志 C:\\Users\\Alice\\AppData\\Local\\DSH\\runtime\\file.jsonl 结束'),
    ).toBe('日志 [REDACTED_PATH]');
    expect(redactPaths('路径 C:/Users/Alice/file.jsonl')).toBe('路径 [REDACTED_PATH]');
  });

  it('覆盖引号内带空格的 Windows 路径', () => {
    expect(redactPaths("open 'C:\\Program Files\\DSH\\app.log' failed")).toBe(
      "open '[REDACTED_PATH]' failed",
    );
  });

  it('覆盖含撇号的未加引号路径，不残留路径或后续上下文', () => {
    const output = redactPaths("open C:\\Users\\O'Brien\\file.log tail");

    expect(output).toBe('open [REDACTED_PATH]');
    expect(output).not.toContain('O');
    expect(output).not.toContain('Brien');
    expect(output).not.toContain('file.log');
  });

  it('覆盖双引号内含撇号的路径，并保留引号与后续上下文', () => {
    const output = redactPaths('open "C:\\Users\\O\'Brien\\file.log" tail');

    expect(output).toBe('open "[REDACTED_PATH]" tail');
    expect(output).not.toContain('Users');
    expect(output).not.toContain('O');
    expect(output).not.toContain('Brien');
    expect(output).not.toContain('file.log');
  });

  it('覆盖单引号内含撇号的路径，贪婪匹配到本行最后一个单引号', () => {
    const output = redactPaths("open 'C:\\Users\\O'Brien\\file.log' tail");

    expect(output).toBe("open '[REDACTED_PATH]' tail");
    expect(output).not.toContain('O');
    expect(output).not.toContain('Brien');
    expect(output).not.toContain('file.log');
  });

  it('覆盖反引号内的路径', () => {
    const output = redactPaths('open `C:\\Users\\Alice\\file.log` tail');

    expect(output).toBe('open `[REDACTED_PATH]` tail');
    expect(output).not.toContain('Users');
    expect(output).not.toContain('file.log');
  });

  it('贪婪匹配允许吞掉同一行后续引号字段', () => {
    const output = redactPaths("open 'C:\\Users\\O'Brien\\a.log' tag 'next' tail");

    expect(output).toBe("open '[REDACTED_PATH]' tail");
    expect(output).not.toContain('O');
    expect(output).not.toContain('Brien');
    expect(output).not.toContain('a.log');
    expect(output).not.toContain('next');
  });

  it('覆盖 UNC 路径', () => {
    expect(redactPaths('共享 \\\\server\\share\\dir\\file.log 不可用')).toBe(
      '共享 [REDACTED_PATH]',
    );
  });

  it('覆盖 POSIX 绝对路径并保留尾部标点', () => {
    expect(redactPaths('读取 /tmp/xds/runtime/ds-memory.endpoint.json 失败')).toBe(
      '读取 [REDACTED_PATH]',
    );
    expect(redactPaths('日志 /var/log/dsh/app.log。')).toBe('日志 [REDACTED_PATH]。');
  });

  it('未加引号且含空格的绝对路径完整脱敏，允许吞掉后续上下文', () => {
    const windowsBackslash = redactPaths('open C:\\Program Files\\DSH\\app.log now');
    const windowsSlash = redactPaths('open C:/Program Files/DSH/app.log now');
    const unc = redactPaths('share \\\\server\\share\\My Folder\\file.log now');
    const posix = redactPaths('read /tmp/my folder/file.log now');

    expect(windowsBackslash).toBe('open [REDACTED_PATH]');
    expect(windowsSlash).toBe('open [REDACTED_PATH]');
    expect(unc).toBe('share [REDACTED_PATH]');
    expect(posix).toBe('read [REDACTED_PATH]');

    for (const output of [windowsBackslash, windowsSlash]) {
      expect(output).not.toContain('Program');
      expect(output).not.toContain('Files');
      expect(output).not.toContain('DSH');
      expect(output).not.toContain('app.log');
    }
    expect(unc).not.toContain('server');
    expect(unc).not.toContain('My Folder');
    expect(unc).not.toContain('file.log');
    expect(posix).not.toContain('my folder');
    expect(posix).not.toContain('folder');
    expect(posix).not.toContain('file.log');
  });

  it('不误伤 HTTP URL（含查询串中的斜杠）', () => {
    const url = 'http://127.0.0.1:3000/send?file=/tmp/secret';
    expect(redactPaths(`请求 ${url} 失败`)).toBe(`请求 ${url} 失败`);
    expect(redactPaths('见 http://127.0.0.1:3000/a，/tmp/b')).toBe(
      '见 http://127.0.0.1:3000/a，[REDACTED_PATH]',
    );
  });

  it('不误伤 HTTPS、FTP 与 WebSocket URL', () => {
    const https = 'https://example.com/a?next=/tmp/secret';
    const ftp = 'ftp://127.0.0.1/a';
    const ftps = 'ftps://127.0.0.1/b';
    const ws = 'wss://127.0.0.1:3000/socket?path=/tmp/c';

    expect(redactPaths(`请求 ${https} 失败`)).toBe(`请求 ${https} 失败`);
    expect(redactPaths(`连接 ${ftp} 与 ${ftps}`)).toBe(`连接 ${ftp} 与 ${ftps}`);
    expect(redactPaths(`连接 ${ws}`)).toBe(`连接 ${ws}`);
  });

  it('覆盖 file:// 本地文件 URL', () => {
    expect(redactPaths('open file:///tmp/secret now')).toBe('open [REDACTED_PATH] now');
    expect(redactPaths('open file:///C:/Users/x/a.log now')).toBe(
      'open [REDACTED_PATH] now',
    );
  });

  it('混合文本只替换路径片段，保留其他内容与 URL', () => {
    const input = String.raw`失败：open 'C:\tmp\a.log'；URL http://127.0.0.1:3000/health；另见 /tmp/b.log 与 \\server\share\c.log`;
    const expected = String.raw`失败：open '[REDACTED_PATH]'；URL http://127.0.0.1:3000/health；另见 [REDACTED_PATH]`;
    expect(redactPaths(input)).toBe(expected);
  });

  it('多行文本逐行替换路径，不跨行吞掉下一行', () => {
    expect(redactPaths('C:\\tmp\\a.log tail\nC:\\tmp\\b.log tail')).toBe(
      '[REDACTED_PATH]\n[REDACTED_PATH]',
    );
  });

  it('/health 等普通绝对斜杠 token 按安全优先整体脱敏', () => {
    expect(redactPaths('/health')).toBe('[REDACTED_PATH]');
    expect(redactPaths('GET /health now')).toBe('GET [REDACTED_PATH]');
  });

  it('空串、普通中文与相对路径不误伤', () => {
    expect(redactPaths('')).toBe('');
    expect(redactPaths('普通中文，没有任何路径。')).toBe('普通中文，没有任何路径。');
    expect(redactPaths('相对路径 src/util/redact.ts 保持不变')).toBe(
      '相对路径 src/util/redact.ts 保持不变',
    );
    expect(redactPaths('相对路径 ./tmp/x 与 ../var/y 保持不变')).toBe(
      '相对路径 ./tmp/x 与 ../var/y 保持不变',
    );
  });
});
