/**
 * v1.1.0 新增：请求体里的 URL 覆盖为什么要校验。
 *
 * §26 允许前端传 model / baseUrl / temperature 覆盖，而服务端是拿着 LLM_API_KEY
 * 去请求那个 baseUrl 的（`clientFromEnv`：密钥作为 Bearer token 发出）。地址不受限时，
 * 任何能访问到本服务的人都能：
 *   1) 让服务端把密钥发到任意主机——凭据外泄，而且外泄发生在服务端，浏览器侧看不出；
 *   2) 借本服务摸内网——169.254.169.254 一类的云元数据地址、localhost 上跑着的其它服务，
 *      从本服务背后打比从外面打容易得多。
 *
 * 判据只针对「来自请求的」地址。运维自己在 LLM_BASE_URL 里配的本地 mock 属于受信配置，
 * 不走这里——否则「服务端指向本地假模型」的用法会被自己挡掉。
 *
 * 域名不能只查字面量：否则一个解析到 127.0.0.1 的域名就绕过了全部规则，
 * 所以域名要解析出地址后再判一遍（解析器可注入，单测不真的查 DNS）。
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/** §12：调用方改请求就能解决的错误，映射成 400 CONFIG_INVALID。
 *  类名与运行时 name 一致：api-error 的 400 映射按 name 认它，
 *  v1.1.0 借用别人的名字（RequestValidationError）会让日志里的错误名指不到真实类型。 */
export class UnsafeRequestUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeRequestUrlError";
  }
}

/** hostname → 地址列表。测试里注入假的，避免单测依赖真实 DNS。 */
export type AddressResolver = (hostname: string) => Promise<readonly string[]>;

const dnsLookup: AddressResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
};

const BLOCKED_HOST_NAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * 不允许出现在请求体 baseUrl 里的 IPv4 段。私网与环回是主要目标；
 * 其余几段本来也不该被公网请求打到，列出来是为了让人一眼看清挡了哪些地方。
 */
const BLOCKED_IPV4: ReadonlyArray<{ cidr: string; why: string }> = [
  { cidr: "0.0.0.0/8", why: "本网络" },
  { cidr: "127.0.0.0/8", why: "环回" },
  { cidr: "10.0.0.0/8", why: "私网" },
  { cidr: "172.16.0.0/12", why: "私网" },
  { cidr: "192.168.0.0/16", why: "私网" },
  { cidr: "169.254.0.0/16", why: "链路本地（含云元数据地址）" },
  { cidr: "100.64.0.0/10", why: "运营商级 NAT" },
  { cidr: "192.0.0.0/24", why: "保留" },
  { cidr: "192.0.2.0/24", why: "文档样例段" },
  { cidr: "192.88.99.0/24", why: "6to4 中继任意播" },
  { cidr: "198.18.0.0/15", why: "基准测试" },
  { cidr: "198.51.100.0/24", why: "文档样例段" },
  { cidr: "203.0.113.0/24", why: "文档样例段" },
  { cidr: "224.0.0.0/4", why: "组播" },
  { cidr: "240.0.0.0/4", why: "保留与广播" },
];

/** 点分十进制 → 32 位无符号整数；不是合法 IPv4 字面量时返回 null。 */
function ipv4ToInt(ip: string): number | null {
  const matched = ip.match(IPV4_PATTERN);
  if (!matched) return null;
  let value = 0;
  for (let octet = 1; octet <= 4; octet += 1) {
    const part = Number(matched[octet]);
    if (part > 255) return null;
    value = value * 256 + part;
  }
  return value;
}

/** CIDR 的网络地址与掩码，都是 32 位无符号整数。 */
function cidrToRange(cidr: string): { network: number; mask: number } {
  const [text, bitsText] = cidr.split("/");
  const network = ipv4ToInt(text) ?? 0;
  const bits = Number(bitsText);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network, mask };
}

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map((entry) => ({
  why: entry.why,
  ...cidrToRange(entry.cidr),
}));

function isPublicIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  if (value === null) return false;
  return !BLOCKED_IPV4_RANGES.some((range) => ((value & range.mask) >>> 0) === range.network);
}

/**
 * 内嵌 IPv4 的 IPv6 前缀：::ffff:0:0/96（IPv4-mapped）与 64:ff9b::/96（NAT64）。
 * 写进 URL 的可能是点分形式（http://[::ffff:127.0.0.1]/），但 WHATWG URL 会把它规范化成
 * 十六进制（[::ffff:7f00:1]），所以这里不匹配点分文本，直接从最后两段取内嵌地址——
 * 两种写法走同一条路，结果一致。
 */
const IPV4_TRANSLATION_PREFIXES: readonly string[] = ["::ffff:", "64:ff9b:"];

/** 单个十六进制段；不是 1~4 位十六进制（含 :: 折叠出来的空段）时返回 null。 */
function parseHextet(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9a-f]{1,4}$/.test(raw)) return null;
  return Number.parseInt(raw, 16);
}

/** 从翻译前缀地址里取内嵌的 IPv4（最后两段拼成 32 位）；取不到返回 null。 */
function embeddedIPv4(address: string): string | null {
  const hextets = address.split(":");
  if (hextets.length < 3) return null;
  const hi = parseHextet(hextets[hextets.length - 2]);
  const lo = parseHextet(hextets[hextets.length - 1]);
  if (hi === null || lo === null) return null;
  const value = ((hi << 16) | lo) >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join(".");
}

function isPublicIPv6(ip: string): boolean {
  // 调用处已去掉 URL.hostname 自带的方括号（Node 的 URL 对 IPv6 会保留它们，isIP 认不出）
  const address = ip.toLowerCase();
  if (address === "::" || address === "::1") return false; // 未指定 / 环回
  if (/^fe[89ab]/.test(address)) return false; // fe80::/10 链路本地
  if (/^fec/.test(address)) return false; // fec0::/10 站点本地（已废弃，但仍有实现认它）
  if (/^f[cd]/.test(address)) return false; // fc00::/7 唯一本地地址
  if (address.startsWith("2001:db8:")) return false; // 文档段
  if (address.startsWith("2002:")) return false; // 6to4 中继任意播
  // 内嵌 IPv4 的翻译前缀：目标地址是那个 IPv4，规则跟着它走
  if (IPV4_TRANSLATION_PREFIXES.some((prefix) => address.startsWith(prefix))) {
    const embedded = embeddedIPv4(address);
    // 取不出内嵌地址就按拒绝处理：验不了就不放行
    return embedded !== null && isPublicIPv4(embedded);
  }
  return true;
}

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIPv4(address);
  if (version === 6) return isPublicIPv6(address);
  return false;
}

function isBlockedHostName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOST_NAMES.has(host)) return true;
  // mDNS / 内网习惯后缀：本机与内网服务常用这些名字，不猜用途，一律挡掉
  return host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

/**
 * 校验一个「来自请求体」的 URL：只允许 http/https，且不能指向本机、环回、私网与保留段。
 * 通过时返回规范化后的 URL（与传入值等价，只是 trim 过）。
 */
export async function assertPublicHttpUrl(
  raw: string,
  resolve: AddressResolver = dnsLookup,
): Promise<string> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new UnsafeRequestUrlError("baseUrl 不能是空字符串");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UnsafeRequestUrlError(`baseUrl 不是合法 URL：${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeRequestUrlError(
      `baseUrl 只支持 http / https，实际是 ${url.protocol.replace(":", "")}`,
    );
  }
  // IPv6 的 URL.hostname 自带方括号（http://[::1]/），isIP 只认不带括号的地址
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostName(host)) {
    throw new UnsafeRequestUrlError(`baseUrl 不允许指向本机地址：${host}`);
  }
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) {
      throw new UnsafeRequestUrlError(`baseUrl 不允许指向非公网地址：${host}`);
    }
    return url.toString();
  }
  // 域名：解析后再判一遍。解析失败按拒绝处理——「验不了就不放行」比「放过去再说」安全。
  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UnsafeRequestUrlError(`baseUrl 的域名解析失败：${host}`);
  }
  if (addresses.length === 0) {
    throw new UnsafeRequestUrlError(`baseUrl 的域名没有解析出地址：${host}`);
  }
  for (const address of addresses) {
    if (!isPublicAddress(address)) {
      throw new UnsafeRequestUrlError(`baseUrl 的域名 ${host} 解析到非公网地址`);
    }
  }
  return url.toString();
}

/**
 * 请求体没带 baseUrl（或带空串）＝用服务端 LLM_BASE_URL。那是运维的受信配置，
 * 不在这里拦；带了值才校验。
 */
export async function assertPublicBaseUrl(
  raw: string | undefined,
  resolve?: AddressResolver,
): Promise<void> {
  if (raw === undefined || raw.trim() === "") return;
  await assertPublicHttpUrl(raw, resolve);
}
