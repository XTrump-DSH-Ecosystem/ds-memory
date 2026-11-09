import { describe, expect, it } from 'vitest';
import {
  classifyIpAddress,
  normalizeFetchableUrl,
  validateWebFetchUrl,
  type IpClassification,
  type LookupFn,
  type UrlPolicyRejectReason,
} from '../../src/tools/web/url-policy.ts';

const publicLookup: LookupFn = async () => [
  { address: '93.184.216.34', family: 4 },
];

describe('classifyIpAddress', () => {
  it.each<[string, IpClassification]>([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['172.32.0.1', 'public'],
    ['126.0.0.1', 'public'],
    ['128.0.0.1', 'public'],
    ['223.255.255.254', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['2a00:1450:4001::1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback'],
    ['::1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['169.254.169.254', 'link_local'],
    ['fe80::1', 'link_local'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['ff02::1', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['100.64.0.1', 'reserved'],
    ['192.0.0.1', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['192.88.99.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['198.51.100.1', 'reserved'],
    ['203.0.113.1', 'reserved'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['3fff::1', 'reserved'],
    ['2001:2::1', 'reserved'],
    ['2001:20::1', 'reserved'],
    ['100::1', 'reserved'],
    ['5f00::1', 'reserved'],
    ['::ffff:127.0.0.1', 'ipv4_mapped'],
    ['::ffff:192.168.1.1', 'ipv4_mapped'],
    ['::ffff:8.8.8.8', 'ipv4_mapped'],
    ['64:ff9b::7f00:1', 'nat64'],
    ['64:ff9b:1::1', 'nat64'],
    ['2002:7f00:1::', 'six_to_four'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'teredo'],
  ])('%s -> %s', (address, expected) => {
    expect(classifyIpAddress(address)).toBe(expected);
  });

  it.each(['', 'not-an-ip', '999.1.1.1', '1.2.3', '[::1', '::gggg'])(
    '拒绝非法 IP：%s',
    (address) => {
      expect(classifyIpAddress(address)).toBe('invalid');
    },
  );
});

describe('validateWebFetchUrl 接受公网地址', () => {
  it.each<[string, string]>([
    ['http://example.com/a?x=1#frag', 'http://example.com/a?x=1'],
    ['https://example.com:443/a', 'https://example.com/a'],
    ['http://example.com:80/a', 'http://example.com/a'],
    ['http://example.com:443/a', 'http://example.com:443/a'],
    ['https://example.com:80/a', 'https://example.com:80/a'],
    ['http://8.8.8.8/', 'http://8.8.8.8/'],
    ['http://[2606:4700:4700::1111]/', 'http://[2606:4700:4700::1111]/'],
    ['http://Example.COM./a#x', 'http://example.com/a'],
  ])('%s', async (input, expected) => {
    const result = await validateWebFetchUrl(input, { lookup: publicLookup });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalizedUrl).toBe(expected);
  });

  it('DNS lookup 使用 all:true 与 verbatim:true', async () => {
    let seenOptions: { all: true; verbatim: true } | null = null;
    const lookup: LookupFn = async (_hostname, options) => {
      seenOptions = options;
      return [{ address: '93.184.216.34', family: 4 }];
    };

    const result = await validateWebFetchUrl('https://example.com/', { lookup });
    expect(result.ok).toBe(true);
    expect(seenOptions).toEqual({ all: true, verbatim: true });
  });
});

describe('validateWebFetchUrl 拒绝矩阵', () => {
  it.each<[string, UrlPolicyRejectReason]>([
    ['ftp://example.com/', 'unsupported_scheme'],
    ['file:///etc/passwd', 'unsupported_scheme'],
    ['http://user:pass@example.com/', 'userinfo_not_allowed'],
    ['http://user@example.com/', 'userinfo_not_allowed'],
    ['http://@example.com/', 'userinfo_not_allowed'],
    ['http://example.com:8080/', 'port_not_allowed'],
    ['http://example.com:22/', 'port_not_allowed'],
    ['http://example.com:0/', 'port_not_allowed'],
    ['http://localhost/', 'localhost'],
    ['http://localhost./', 'localhost'],
    ['http://localhost.../', 'localhost'],
    ['http://foo.localhost/', 'localhost'],
    ['http://foo.localhost.../', 'localhost'],
    ['http://example.local/', 'localhost'],
    ['http://metadata.google.internal/', 'localhost'],
    ['http://home.arpa/', 'localhost'],
    ['http://127.0.0.1/', 'loopback_address'],
    ['http://127.0.0.1.../', 'loopback_address'],
    ['http://127.1/', 'loopback_address'],
    ['http://[::1]/', 'loopback_address'],
    ['http://10.0.0.1/', 'private_address'],
    ['http://172.16.0.1/', 'private_address'],
    ['http://192.168.1.1/', 'private_address'],
    ['http://[fc00::1]/', 'private_address'],
    ['http://169.254.169.254/', 'link_local_address'],
    ['http://[fe80::1]/', 'link_local_address'],
    ['http://224.0.0.1/', 'multicast_address'],
    ['http://[ff02::1]/', 'multicast_address'],
    ['http://0.0.0.0/', 'unspecified_address'],
    ['http://[::]/', 'unspecified_address'],
    ['http://100.64.0.1/', 'reserved_address'],
    ['http://192.0.0.1/', 'reserved_address'],
    ['http://192.0.2.1/', 'reserved_address'],
    ['http://198.18.0.1/', 'reserved_address'],
    ['http://198.51.100.1/', 'reserved_address'],
    ['http://203.0.113.1/', 'reserved_address'],
    ['http://240.0.0.1/', 'reserved_address'],
    ['http://255.255.255.255/', 'reserved_address'],
    ['http://[2001:db8::1]/', 'reserved_address'],
    ['http://[3fff::1]/', 'reserved_address'],
    ['http://[2001:2::1]/', 'reserved_address'],
    ['http://[100::1]/', 'reserved_address'],
    ['http://[5f00::1]/', 'reserved_address'],
    ['http://[::ffff:127.0.0.1]/', 'ipv4_mapped_ipv6'],
    ['http://[::ffff:8.8.8.8]/', 'ipv4_mapped_ipv6'],
    ['http://[64:ff9b::7f00:1]/', 'nat64_address'],
    ['http://[64:ff9b:1::1]/', 'nat64_address'],
    ['http://[2002:7f00:1::]/', 'six_to_four_address'],
    ['http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/', 'teredo_address'],
  ])('%s -> %s', async (input, reason) => {
    const result = await validateWebFetchUrl(input, { lookup: publicLookup });
    expect(result).toEqual({ ok: false, reason });
  });

  it('拒绝控制字符、空白与反斜杠', async () => {
    await expect(
      validateWebFetchUrl('http://example.com/\u0000', { lookup: publicLookup }),
    ).resolves.toEqual({ ok: false, reason: 'control_character' });
    for (const input of [
      'http://example.com/\t',
      'http://example.com/\r',
      'http://example.com/\n',
      '\thttp://example.com/',
      'http://example.com/\u007f',
    ]) {
      await expect(
        validateWebFetchUrl(input, { lookup: publicLookup }),
      ).resolves.toEqual({ ok: false, reason: 'control_character' });
    }
    await expect(
      validateWebFetchUrl('  http://example.com/  ', { lookup: publicLookup }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      validateWebFetchUrl('http://example.com/a b', { lookup: publicLookup }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_url' });
    await expect(
      validateWebFetchUrl('http://example.com\\@evil.com/', { lookup: publicLookup }),
    ).resolves.toEqual({ ok: false, reason: 'invalid_url' });
  });

  it('拒绝 DNS 私网、空结果、查询失败与非法地址', async () => {
    const cases: Array<[LookupFn, UrlPolicyRejectReason]> = [
      [
        async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ],
        'dns_non_public_address',
      ],
      [async () => [], 'dns_empty'],
      [
        async () => {
          throw new Error('dns down');
        },
        'dns_lookup_failed',
      ],
      [async () => [{ address: 'not-an-ip', family: 4 }], 'dns_lookup_failed'],
    ];

    for (const [lookup, reason] of cases) {
      const result = await validateWebFetchUrl('https://example.com/', { lookup });
      expect(result).toEqual({ ok: false, reason });
    }
  });

  it('DNS 同时返回公网 IPv4 与 IPv6 时接受', async () => {
    const result = await validateWebFetchUrl('https://example.com/', {
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.addresses).toHaveLength(2);
  });

  it('signal 已 abort 时不查询 DNS', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    const lookup: LookupFn = async () => {
      called = true;
      return [{ address: '93.184.216.34', family: 4 }];
    };

    const result = await validateWebFetchUrl('https://example.com/', {
      lookup,
      signal: controller.signal,
    });
    expect(result).toEqual({ ok: false, reason: 'aborted' });
    expect(called).toBe(false);
  });

  it('DNS 查询可被 AbortSignal 取消', async () => {
    const controller = new AbortController();
    let called = false;
    const lookup: LookupFn = () => {
      called = true;
      return new Promise(() => undefined);
    };

    const pending = validateWebFetchUrl('https://example.com/', {
      lookup,
      signal: controller.signal,
      dnsTimeoutMs: 10_000,
    });
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'aborted' });
    expect(called).toBe(true);
  });

  it('DNS 查询超时返回 dns_timeout', async () => {
    const lookup: LookupFn = () => new Promise(() => undefined);
    const result = await validateWebFetchUrl('https://example.com/', {
      lookup,
      dnsTimeoutMs: 10,
    });
    expect(result).toEqual({ ok: false, reason: 'dns_timeout' });
  });

  it('DNS 返回非数组时按查询失败处理', async () => {
    const lookup = (async () => 'not-an-array') as unknown as LookupFn;
    const result = await validateWebFetchUrl('https://example.com/', { lookup });
    expect(result).toEqual({ ok: false, reason: 'dns_lookup_failed' });
  });
});

describe('normalizeFetchableUrl', () => {
  it('去 fragment、保留 query、归一化默认端口与大小写', () => {
    expect(normalizeFetchableUrl('http://Example.COM:80/a?x=1#frag')).toBe(
      'http://example.com/a?x=1',
    );
    expect(normalizeFetchableUrl('https://example.com:443/a#frag')).toBe(
      'https://example.com/a',
    );
  });

  it('查询串精确保留，供 allowlist 精确匹配', () => {
    expect(normalizeFetchableUrl('https://example.com/a?b=2&a=1')).toBe(
      'https://example.com/a?b=2&a=1',
    );
  });

  it.each([
    'http://127.0.0.1/',
    'http://localhost/',
    'http://example.com:8080/',
    'ftp://example.com/',
    'http://user@example.com/',
    'not a url',
  ])('拒绝不可抓取 URL：%s', (input) => {
    expect(normalizeFetchableUrl(input)).toBeNull();
  });
});
