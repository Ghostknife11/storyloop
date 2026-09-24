import { describe, expect, it, vi } from "vitest";
import { assertPublicBaseUrl, assertPublicHttpUrl, UnsafeRequestUrlError } from "@/lib/url-guard";
import { toApiError } from "@/lib/api-error";
import { planStory, startRun } from "@/lib/generate-service";

/**
 * §26 请求体 baseUrl 覆盖的地址校验。
 *
 * 全部用例都注入假解析器——不真的查 DNS，也不发任何请求；
 * 要打的地址全是文档保留段（example.invalid / example.com / 文档 IP），不碰真实主机。
 */

/** 解析器假件：hostname → 固定地址列表。 */
function resolverOf(table: Record<string, readonly string[]>): (hostname: string) => Promise<readonly string[]> {
  return async (hostname) => table[hostname] ?? [];
}

const PUBLIC_RESOLVER = resolverOf({ "api.example.com": ["93.184.216.34"] });

async function rejects(url: string, resolver = PUBLIC_RESOLVER): Promise<void> {
  await expect(assertPublicHttpUrl(url, resolver)).rejects.toThrow(UnsafeRequestUrlError);
}

async function accepts(url: string, resolver = PUBLIC_RESOLVER): Promise<void> {
  await expect(assertPublicHttpUrl(url, resolver)).resolves.toBeDefined();
}

describe("协议", () => {
  it("只允许 http / https", async () => {
    await rejects("ftp://api.example.com/v1");
    await rejects("file:///etc/passwd");
    await rejects("gopher://api.example.com/v1");
  });

  it("http 与 https 都放行（地址合法时）", async () => {
    await accepts("https://api.example.com/v1");
    await accepts("http://api.example.com/v1");
  });

  it("空串 / 空白 / 不是 URL → 拒绝", async () => {
    await rejects("   ");
    await rejects("api.example.com/v1");
    await rejects("");
  });
});

describe("本机与环回", () => {
  it("localhost 及 .localhost 后缀一律拒绝", async () => {
    await rejects("http://localhost:9999/v1");
    await rejects("http://anything.localhost/v1");
    await rejects("http://LOCALHOST:9999/v1");
  });

  it("IPv4 环回与本网络段拒绝", async () => {
    await rejects("http://127.0.0.1:9999/v1");
    await rejects("http://127.8.9.10/v1");
    await rejects("http://0.0.0.0/v1");
  });

  it("IPv6 环回与未指定地址拒绝", async () => {
    await rejects("http://[::1]/v1");
    await rejects("http://[::]/v1");
  });

  it("解析到环回的域名也拒绝——不能靠字面量绕过", async () => {
    await rejects("http://sneaky.example.com/v1", resolverOf({ "sneaky.example.com": ["127.0.0.1"] }));
  });
});

describe("私网、链路本地与保留段", () => {
  it("三段私网地址拒绝", async () => {
    await rejects("http://10.1.2.3/v1");
    await rejects("http://172.16.0.9/v1");
    await rejects("http://172.31.255.255/v1");
    await rejects("http://192.168.0.1/v1");
  });

  it("云元数据地址拒绝", async () => {
    await rejects("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
  });

  it("链路本地、运营商级 NAT 与其它保留段拒绝", async () => {
    await rejects("http://169.254.0.1/v1");
    await rejects("http://100.64.0.1/v1");
    await rejects("http://192.0.2.1/v1");
    await rejects("http://198.51.100.7/v1");
    await rejects("http://203.0.113.9/v1");
    await rejects("http://224.0.0.1/v1");
    await rejects("http://240.0.0.8/v1");
  });

  it("IPv6 链路本地、唯一本地与文档段拒绝", async () => {
    await rejects("http://[fe80::1]/v1");
    await rejects("http://[fc00::1]/v1");
    await rejects("http://[fd12:3456::1]/v1");
    await rejects("http://[2001:db8::1]/v1");
  });

  // v1.1.1：这里要的是「按内嵌的那个 IPv4 判」。
  // 写进 URL 的点分形式会被 WHATWG URL 规范化成十六进制（[::ffff:127.0.0.1] → [::ffff:7f00:1]），
  // v1.1.0 里那段匹配点分文本的分支因此永远走不到——它靠的是后一个分支返回 false 的 fail-closed。
  it("IPv4-mapped IPv6 按内嵌 IPv4 判，环回与云元数据不会从这扇门进来", async () => {
    await rejects("http://[::ffff:127.0.0.1]/v1");
    await rejects("http://[::ffff:169.254.169.254]/v1");
    await rejects("http://[::ffff:10.0.0.1]/v1");
  });

  it("内嵌公网 IPv4 的 mapped 地址要放行——不能把合法地址一起误拒", async () => {
    await accepts("https://[::ffff:93.184.216.34]/v1");
  });

  it("NAT64 / 站点本地 / 6to4 同样按内嵌地址或前缀判", async () => {
    await rejects("https://[64:ff9b::7f00:1]/v1"); // NAT64 指向环回
    await rejects("https://[64:ff9b::a9fe:a9fe]/v1"); // NAT64 指向云元数据地址
    await accepts("https://[64:ff9b::5db8:d822]/v1"); // NAT64 指向公网 IPv4
    await rejects("http://[fec0::1]/v1"); // 站点本地
    await rejects("http://[2002:7f00:1::1]/v1"); // 6to4 中继段
  });

  it("解析到私网的域名拒绝", async () => {
    await rejects(
      "https://internal.example.com/v1",
      resolverOf({ "internal.example.com": ["10.0.0.5"] }),
    );
  });

  it("一个域名解析出多个地址时，只要有一个非公网就拒绝", async () => {
    await rejects(
      "https://dual.example.com/v1",
      resolverOf({ "dual.example.com": ["93.184.216.34", "192.168.1.1"] }),
    );
  });

  it("域名解析失败按拒绝处理——验不了就不放行", async () => {
    await rejects("https://nx.example.com/v1", async () => {
      throw new Error("DNS 查询失败");
    });
  });

  it("域名解析出空列表也拒绝", async () => {
    await rejects("https://empty.example.com/v1", resolverOf({ "empty.example.com": [] }));
  });
});

describe("公网地址", () => {
  it("公网 IPv4 与域名放行", async () => {
    await accepts("https://93.184.216.34/v1");
    await accepts("https://93.184.216.35/v1");
    await accepts("https://api.example.com/v1");
  });

  it("公网 IPv6 放行", async () => {
    await accepts("https://[2606:2800:220:1:248:1893:25c8:1946]/v1");
  });

  it("172.32 之后的地址不是私网", async () => {
    await accepts("http://172.32.0.1/v1");
  });

  it("放行的 URL 会被规范化", async () => {
    await expect(assertPublicHttpUrl("  https://api.example.com/v1  ", PUBLIC_RESOLVER)).resolves.toBe(
      "https://api.example.com/v1",
    );
  });
});

describe("与服务端错误映射的衔接", () => {
  it("类名与运行时 name 一致，映射成 400 CONFIG_INVALID", () => {
    const httpError = new UnsafeRequestUrlError("baseUrl 不允许指向非公网地址：127.0.0.1");
    // v1.1.0 借用别人的名字，日志里的错误名指不到真实类型；v1.1.1 改回一致
    expect(httpError.name).toBe("UnsafeRequestUrlError");
    const apiError = toApiError(httpError);
    expect(apiError.httpStatus).toBe(400);
    expect(apiError.body().error.code).toBe("CONFIG_INVALID");
  });
});

describe("assertPublicBaseUrl", () => {
  it("请求没带 baseUrl / 带空串 → 直接放行（服务端 LLM_BASE_URL 是受信配置）", async () => {
    await expect(assertPublicBaseUrl(undefined)).resolves.toBeUndefined();
    await expect(assertPublicBaseUrl("")).resolves.toBeUndefined();
    await expect(assertPublicBaseUrl("   ")).resolves.toBeUndefined();
  });

  it("带了值就按 assertPublicHttpUrl 校验", async () => {
    await expect(assertPublicBaseUrl("http://127.0.0.1:9999/v1")).rejects.toThrow(
      UnsafeRequestUrlError,
    );
    await expect(assertPublicBaseUrl("https://api.example.com/v1", PUBLIC_RESOLVER)).resolves.toBeUndefined();
  });
});

// startRun 会先校验 StoryConfig（target_words 必填），所以这里给全字段，
// 让它通过配置校验、正好走到 baseUrl 这道关卡。
const RUN_BASE = {
  config: {
    title: "深夜食堂",
    genre: "治愈",
    premise: "一个只在深夜营业的小餐馆。",
    target_words: 500,
  },
};

describe("服务层接线（§26）", () => {
  // 关键是「一个字节都还没发」：密钥是跟着请求发出去的，拒绝必须发生在建连接之前。
  function fetchSpy() {
    const calls = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", calls);
    return calls;
  }

  it("planStory 收到非公网 baseUrl → 400 CONFIG_INVALID，且没有发出任何请求", async () => {
    const calls = fetchSpy();
    const r = await planStory({
      title: "深夜食堂",
      genre: "治愈",
      premise: "一个只在深夜营业的小餐馆。",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
    expect(calls).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("startRun 收到云元数据地址 → 400，且没有发出任何请求", async () => {
    const calls = fetchSpy();
    const r = await startRun({
      ...RUN_BASE,
      baseUrl: "http://169.254.169.254/latest/meta-data",
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
    expect(calls).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("startRun 收到 ftp 与 localhost 地址 → 400，且没有发出任何请求", async () => {
    // 这两个用例不需要真的查 DNS：协议与主机名都是字面量就能判掉的
    for (const baseUrl of ["ftp://api.example.com/v1", "http://localhost:9999/v1"]) {
      const calls = fetchSpy();
      const r = await startRun({ ...RUN_BASE, baseUrl });
      expect(r.status).toBe(400);
      expect((r.json as { error: { code: string } }).error.code).toBe("CONFIG_INVALID");
      expect(calls).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("拒绝原因是 URL 校验，不是别的关卡", async () => {
    const calls = fetchSpy();
    const r = await startRun({ ...RUN_BASE, baseUrl: "http://169.254.169.254/latest/meta-data" });
    expect((r.json as { error: { message: string } }).error.message).toContain("非公网地址");
    expect(calls).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
