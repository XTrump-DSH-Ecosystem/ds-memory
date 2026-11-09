import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SessionMap,
  groupSessionKey,
  privateSessionKey,
  type SessionMapOptions,
  type SessionSource,
} from '../../src/qq/session-map.ts';

const OWNER_QQ = 10001;
const ALLOW_GROUP = 555000111;
const DENIED_GROUP = 555000999;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xds-session-map-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeMap(overrides: Partial<SessionMapOptions> = {}): SessionMap {
  return new SessionMap({
    stateDir: dir,
    ownerQQ: OWNER_QQ,
    allowGroups: [ALLOW_GROUP],
    denyPrivate: [20002],
    denyGroups: [DENIED_GROUP],
    onWarn: () => undefined,
    ...overrides,
  });
}

function privateSource(id: string | number): SessionSource {
  return { kind: 'private', id: String(id), groupName: null };
}

function groupSource(
  id: string | number,
  groupName: string | null = null,
): SessionSource {
  return { kind: 'group', id: String(id), groupName };
}

describe('SessionMap.classify', () => {
  it('denyPrivate 优先于 owner', () => {
    const map = makeMap({ denyPrivate: [OWNER_QQ] });

    expect(map.classify(privateSource(OWNER_QQ))).toEqual({
      action: 'deny',
      sessionKey: null,
      reason: 'deny_private',
      modelEligible: false,
    });
  });

  it('owner 私聊放行，陌生私聊忽略', () => {
    const map = makeMap();

    expect(map.classify(privateSource(OWNER_QQ))).toEqual({
      action: 'allow',
      sessionKey: privateSessionKey(String(OWNER_QQ)),
      reason: 'owner',
      modelEligible: true,
    });
    expect(map.classify(privateSource(30003))).toEqual({
      action: 'ignore',
      sessionKey: null,
      reason: 'stranger_private',
      modelEligible: false,
    });
  });

  it('denyGroups 优先于 allowGroups', () => {
    const map = makeMap({ allowGroups: [ALLOW_GROUP], denyGroups: [ALLOW_GROUP] });

    expect(map.classify(groupSource(ALLOW_GROUP, '被拉黑的群'))).toEqual({
      action: 'deny',
      sessionKey: null,
      reason: 'deny_group',
      modelEligible: false,
    });
  });

  it('白名单群放行，其他群忽略', () => {
    const map = makeMap();

    expect(map.classify(groupSource(ALLOW_GROUP, '三人小群'))).toEqual({
      action: 'allow',
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      reason: 'allow_group',
      modelEligible: false,
    });
    expect(map.classify(groupSource(60000, '陌生群'))).toEqual({
      action: 'ignore',
      sessionKey: null,
      reason: 'group_not_allowed',
      modelEligible: false,
    });
  });

  it('ownerQQ=0 不匹配任何私聊', () => {
    const map = makeMap({ ownerQQ: 0 });

    expect(map.classify(privateSource(0))).toEqual({
      action: 'ignore',
      sessionKey: null,
      reason: 'stranger_private',
      modelEligible: false,
    });
  });

  it('白名单群：owner sender 可进模型，非 owner / 缺 sender fail-closed', () => {
    const map = makeMap();

    expect(map.classify(groupSource(ALLOW_GROUP, '三人小群'), String(OWNER_QQ))).toEqual({
      action: 'allow',
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      reason: 'allow_group',
      modelEligible: true,
    });
    expect(map.classify(groupSource(ALLOW_GROUP, '三人小群'), '222333444')).toEqual({
      action: 'allow',
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      reason: 'allow_group',
      modelEligible: false,
    });
    expect(map.classify(groupSource(ALLOW_GROUP, '三人小群'))).toEqual({
      action: 'allow',
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      reason: 'allow_group',
      modelEligible: false,
    });
  });

  it('开启普通成员回复后：成员仅 @/引用 可进模型，owner 仍豁免', () => {
    const map = makeMap({ allowGroupMemberReply: true });

    expect(
      map.classify(groupSource(ALLOW_GROUP, '三人小群'), '222333444', {
        isAtBot: true,
      }),
    ).toEqual({
      action: 'allow',
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      reason: 'allow_group',
      modelEligible: true,
    });
    expect(
      map.classify(groupSource(ALLOW_GROUP, '三人小群'), '222333444', {
        isAtBot: false,
      }),
    ).toEqual({
      action: 'allow',
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      reason: 'allow_group',
      modelEligible: false,
    });
    expect(
      map.classify(groupSource(ALLOW_GROUP, '三人小群'), String(OWNER_QQ), {
        isAtBot: false,
      }),
    ).toEqual({
      action: 'allow',
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      reason: 'allow_group',
      modelEligible: true,
    });
  });

  it('groupWake=all 时开启成员回复，非 @ 成员也可进模型', () => {
    const map = makeMap({ allowGroupMemberReply: true, groupWake: 'all' });

    expect(
      map.classify(groupSource(ALLOW_GROUP, '三人小群'), '222333444', {
        isAtBot: false,
      }).modelEligible,
    ).toBe(true);
  });
});

describe('SessionMap.record', () => {
  it('被拒与忽略的消息不建会话、不落盘', () => {
    const map = makeMap();
    const filePath = join(dir, 'qq-sessions.json');

    expect(map.record(privateSource(20002))).toBeNull();
    expect(map.record(privateSource(30003))).toBeNull();
    expect(map.record(groupSource(DENIED_GROUP))).toBeNull();
    expect(map.record(groupSource(60000))).toBeNull();
    expect(existsSync(filePath)).toBe(false);
    expect(map.count).toBe(0);
  });

  it('只记录 allow，并维护 firstSeen/lastSeen/messageCount/groupName', () => {
    const map = makeMap();

    expect(map.record(privateSource(OWNER_QQ), 1_000)).toBe(
      privateSessionKey(String(OWNER_QQ)),
    );
    expect(map.record(groupSource(ALLOW_GROUP, '三人小群'), 2_000)).toBe(
      groupSessionKey(String(ALLOW_GROUP)),
    );
    expect(map.record(groupSource(ALLOW_GROUP, '改名后的群'), 3_000)).toBe(
      groupSessionKey(String(ALLOW_GROUP)),
    );

    expect(map.get(privateSessionKey(String(OWNER_QQ)))).toEqual({
      sessionKey: privateSessionKey(String(OWNER_QQ)),
      kind: 'private',
      id: String(OWNER_QQ),
      groupName: null,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
      messageCount: 1,
    });
    expect(map.get(groupSessionKey(String(ALLOW_GROUP)))).toEqual({
      sessionKey: groupSessionKey(String(ALLOW_GROUP)),
      kind: 'group',
      id: String(ALLOW_GROUP),
      groupName: '改名后的群',
      firstSeenAt: 2_000,
      lastSeenAt: 3_000,
      messageCount: 2,
    });

    const persisted = JSON.parse(readFileSync(join(dir, 'qq-sessions.json'), 'utf8')) as {
      v: number;
      sessions: unknown[];
    };
    expect(persisted.v).toBe(1);
    expect(persisted.sessions).toHaveLength(2);
  });

  it('默认时间源可用于首次与后续记录', () => {
    let now = 10_000;
    const map = makeMap({ now: () => now });
    const key = groupSessionKey(String(ALLOW_GROUP));

    map.record(groupSource(ALLOW_GROUP, '群'));
    now = 11_000;
    map.record(groupSource(ALLOW_GROUP, '群'));

    expect(map.get(key)).toMatchObject({
      firstSeenAt: 10_000,
      lastSeenAt: 11_000,
      messageCount: 2,
    });
  });

  it('重启后从 qq-sessions.json 恢复会话', () => {
    const first = makeMap({ now: () => 1_000 });
    first.record(groupSource(ALLOW_GROUP, '三人小群'));
    first.record(groupSource(ALLOW_GROUP, '三人小群'));

    const second = makeMap({ now: () => 2_000 });
    expect(second.list()).toEqual([
      {
        sessionKey: groupSessionKey(String(ALLOW_GROUP)),
        kind: 'group',
        id: String(ALLOW_GROUP),
        groupName: '三人小群',
        firstSeenAt: 1_000,
        lastSeenAt: 1_000,
        messageCount: 2,
      },
    ]);
  });

  it('坏会话文件告警并按空映射继续，坏记录被跳过', () => {
    const warnings: string[] = [];
    writeFileSync(join(dir, 'qq-sessions.json'), '{broken', 'utf8');

    const broken = makeMap({ onWarn: (message) => warnings.push(message) });
    expect(broken.list()).toEqual([]);
    expect(warnings).toEqual(['qq-sessions 读取失败，按空会话继续']);

    writeFileSync(
      join(dir, 'qq-sessions.json'),
      JSON.stringify({
        v: 1,
        sessions: [
          {
            sessionKey: privateSessionKey(String(OWNER_QQ)),
            kind: 'private',
            id: String(OWNER_QQ),
            groupName: null,
            firstSeenAt: 1,
            lastSeenAt: 2,
            messageCount: 1,
          },
          {
            sessionKey: 'group:broken',
            kind: 'group',
            id: 'broken',
            groupName: null,
            firstSeenAt: 1,
            lastSeenAt: 2,
            messageCount: 'one',
          },
        ],
      }),
      'utf8',
    );

    const partiallyValid = makeMap();
    expect(partiallyValid.list()).toHaveLength(1);
    expect(partiallyValid.get(privateSessionKey(String(OWNER_QQ)))).toBeDefined();
  });

  it('持久化失败只告警，不破坏当前内存映射', () => {
    const warnings: string[] = [];
    const blocker = join(dir, 'state-file');
    writeFileSync(blocker, 'not a directory', 'utf8');
    const map = new SessionMap({
      stateDir: blocker,
      ownerQQ: OWNER_QQ,
      allowGroups: [ALLOW_GROUP],
      denyPrivate: [],
      denyGroups: [],
      now: () => 1_000,
      onWarn: (message) => warnings.push(message),
    });

    expect(map.record(groupSource(ALLOW_GROUP, '群'))).toBe(
      groupSessionKey(String(ALLOW_GROUP)),
    );
    expect(map.count).toBe(1);
    expect(warnings).toEqual(['qq-sessions 写入失败']);
  });
});
