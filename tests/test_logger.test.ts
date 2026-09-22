import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, redactSecrets } from "@/lib/logger";

/**
 * §8/§9/§10 统一日志：等级过滤、run/attempt/repair 前缀、密钥脱敏。
 * 只做工程日志——不引入 Metrics / Trace / Prometheus（§10）。
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** 捕获一段时间内的 console 输出。 */
function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const err = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return {
    lines,
    restore: () => {
      log.mockRestore();
      err.mockRestore();
    },
  };
}

describe("§8 等级过滤", () => {
  it("低于当前等级的消息不输出", () => {
    const out = capture();
    const logger = new Logger({}, "info");
    logger.debug("debug 消息");
    logger.info("info 消息");
    logger.warning("warning 消息");
    logger.error("error 消息");
    out.restore();
    expect(out.lines).toHaveLength(3);
    expect(out.lines.join("\n")).not.toContain("debug 消息");
    expect(out.lines.join("\n")).toContain("info 消息");
  });

  it("ERROR 等级只放错误出去", () => {
    const out = capture();
    const logger = new Logger({}, "error");
    logger.debug("d");
    logger.info("i");
    logger.warning("w");
    logger.error("e");
    out.restore();
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("ERROR e");
  });

  it("DEBUG 等级全放行", () => {
    const out = capture();
    const logger = new Logger({}, "debug");
    logger.debug("d");
    logger.info("i");
    logger.warning("w");
    logger.error("e");
    out.restore();
    expect(out.lines).toHaveLength(4);
  });

  it("enabled() 与是否真的写出保持一致", () => {
    const logger = new Logger({}, "warning");
    expect(logger.enabled("warning")).toBe(true);
    expect(logger.enabled("error")).toBe(true);
    expect(logger.enabled("info")).toBe(false);
    expect(logger.enabled("debug")).toBe(false);
  });

  it("LOG_LEVEL 环境变量决定缺省等级", () => {
    vi.stubEnv("LOG_LEVEL", "error");
    const out = capture();
    new Logger().info("不该出现");
    new Logger().error("该出现");
    out.restore();
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toContain("该出现");
  });

  it("warning / error 走 stderr，info / debug 走 stdout", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => stdout.push(a.map(String).join(" ")));
    const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => stderr.push(a.map(String).join(" ")));
    const logger = new Logger({}, "debug");
    logger.debug("d");
    logger.info("i");
    logger.warning("w");
    logger.error("e");
    log.mockRestore();
    err.mockRestore();
    expect(stdout.join(" ")).toContain("DEBUG d");
    expect(stdout.join(" ")).toContain("INFO i");
    expect(stderr.join(" ")).toContain("WARNING w");
    expect(stderr.join(" ")).toContain("ERROR e");
  });
});

describe("§9 上下文前缀", () => {
  it("run / attempt / repair 三段齐全", () => {
    const out = capture();
    new Logger({ run_id: "20260922_101500_ab12cd", attempt_number: 1, repair_number: 1 }, "info").info("repair completed");
    out.restore();
    expect(out.lines[0]).toBe("[run=20260922_101500_ab12cd attempt=1 repair=1] INFO repair completed");
  });

  it("只有 run_id；Attempt 内只有 run + attempt", () => {
    const out = capture();
    new Logger({ run_id: "r1" }, "info").info("planning started");
    new Logger({ run_id: "r1", attempt_number: 2 }, "info").info("generation completed");
    out.restore();
    expect(out.lines[0]).toBe("[run=r1] INFO planning started");
    expect(out.lines[1]).toBe("[run=r1 attempt=2] INFO generation completed");
  });

  it("没有任何上下文时用 [app]", () => {
    const out = capture();
    new Logger({}, "info").info("server started");
    out.restore();
    expect(out.lines[0]).toBe("[app] INFO server started");
  });

  it("child() 继承父级上下文并覆盖同名字段", () => {
    const out = capture();
    const parent = new Logger({ run_id: "r1", attempt_number: 1 }, "info");
    parent.child({ repair_number: 2 }).info("first");
    parent.child({ repair_number: 3 }).info("second");
    parent.child({ attempt_number: 2 }).info("third");
    out.restore();
    expect(out.lines[0]).toContain("[run=r1 attempt=1 repair=2]");
    expect(out.lines[1]).toContain("[run=r1 attempt=1 repair=3]");
    expect(out.lines[2]).toContain("[run=r1 attempt=2]");
  });

  it("child() 不修改父 Logger 自己的上下文", () => {
    const out = capture();
    const parent = new Logger({ run_id: "r1" }, "info");
    parent.child({ attempt_number: 1 }).info("child");
    parent.info("parent");
    out.restore();
    expect(out.lines[1]).toBe("[run=r1] INFO parent");
  });
});

describe("§9 密钥脱敏", () => {
  // 密钥形态串在运行时拼出来：测试只需要一个「看起来像密钥」的输入，
  // 源码里不直接落下任何凭证形状的字面量。
  const fakeKey = "sk-" + "0123456789abcdef";
  const fakeJson = '{"api_key":"' + fakeKey + '","note":"keep"}';

  it("sk- 形态的 Key 被打码", () => {
    expect(redactSecrets("key is " + fakeKey)).toBe("key is sk-***");
  });

  it("Authorization: Bearer <token> 被打码", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-ghi_jkl")).toBe("Authorization: Bearer ***");
  });

  it("JSON 里的 api_key / token / password 等字段值被打码", () => {
    const masked = redactSecrets(fakeJson);
    expect(masked).toContain('"api_key":"***"');
    expect(masked).not.toContain(fakeKey);
    expect(masked).toContain('"note":"keep"');
  });

  it("正文本身不受影响（没有密钥形态就不动）", () => {
    expect(redactSecrets("陈岚推开派出所的玻璃门。")).toBe("陈岚推开派出所的玻璃门。");
  });

  it("日志行整体脱敏：Error 与对象都过一遍", () => {
    const out = capture();
    new Logger({ run_id: "r1" }, "info").error("llm failed", new Error("401 from " + fakeKey));
    new Logger({}, "info").info("payload", { api_key: fakeKey, story: "正文" });
    out.restore();
    for (const line of out.lines) {
      expect(line).not.toContain(fakeKey);
    }
    expect(out.lines[0]).toContain("401 from sk-***");
    expect(out.lines[1]).toContain("正文");
  });
});
