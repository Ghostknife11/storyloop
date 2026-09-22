import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT_OK, EXIT_RUNTIME, EXIT_USAGE, runCli } from "../scripts/generate-cli";
import { SAMPLE_BEAT_PLAN, SAMPLE_CONFIG, withTmpDir } from "./helpers/fixtures";

/**
 * v1.0.0 合同测试：CLI 契约冻结（TASK §29/§30/§52）。
 *
 * 冻结四件事：命令集、退出码语义（0/1/2）、--help 可用且进 standard output、
 * 参数与配置不合法一律 2 而不是 1。validate/plan 之外的命令会打模型，这里只用
 * --help 与纯粹的参数错误路径（§47 铁律：不碰真实付费 API）。
 */

const COMMANDS = ["run", "plan", "review", "validate", "repair"] as const;

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const USAGE_MARKERS = [
  "用法：",
  "命令：",
  "退出码：0 正常结束；1 运行时失败；2 参数或配置不合法。",
  "--help",
] as const;

describe("v1.0.0 CLI 冻结 — 退出码", () => {
  it("退出码常量就是 0 / 1 / 2", () => {
    expect([EXIT_OK, EXIT_RUNTIME, EXIT_USAGE]).toEqual([0, 1, 2]);
  });

  it("无参数时打印主用法到 stderr，退出码 2", async () => {
    const cap = io();
    const code = await runCli([], cap.write);
    expect(code).toBe(EXIT_USAGE);
    expect(cap.err.join("")).toContain("用法：");
    expect(cap.out).toEqual([]);
  });

  it("--help 与每个命令的 --help 都进 stdout 且退出码 0", async () => {
    for (const args of [["--help"], ["-h"], ...COMMANDS.map((c) => [c, "--help"])]) {
      const cap = io();
      const code = await runCli(args, cap.write);
      expect(code, `${args.join(" ")} 应退出 0`).toBe(EXIT_OK);
      expect(cap.err, `${args.join(" ")} 不应写 stderr`).toEqual([]);
    }
  });

  it("主用法带齐命令清单、退出码说明与配置来源", async () => {
    const cap = io();
    await runCli(["--help"], cap.write);
    const text = cap.out.join("\n");
    for (const marker of USAGE_MARKERS) expect(text).toContain(marker);
    for (const command of COMMANDS) expect(text).toContain(command);
    // 配置来源里必须说明 API Key 只来自服务端环境
    expect(text).toContain("LLM_API_KEY");
    expect(text).toContain("API Key 只来自服务端环境");
  });

  it("每个子命令的用法只列自己那套参数", async () => {
    const run = io();
    await runCli(["run", "--help"], run.write);
    expect(run.out.join("\n")).toContain("--max-attempts");
    expect(run.out.join("\n")).toContain("--min-score");

    const validate = io();
    await runCli(["validate", "--help"], validate.write);
    expect(validate.out.join("\n")).toContain("--story");
    expect(validate.out.join("\n")).not.toContain("--max-attempts");

    const repair = io();
    await runCli(["repair", "--help"], repair.write);
    expect(repair.out.join("\n")).toContain("--issue-type");
    expect(repair.out.join("\n")).toContain("--issue-message");
  });
});

describe("v1.0.0 CLI 冻结 — 参数错误一律 2", () => {
  it("未知命令、未知 flag、缺必填项都是 2，且错误说明在 stderr", async () => {
    withConfig();
    const cases: string[][] = [
      ["deploy"],
      ["run", "--nope", "x", "--config", "config.json"],
      ["run"],
      ["review", "--config", "config.json"],
      ["validate", "--config", "config.json"],
      ["repair", "--config", "config.json"],
    ];
    for (const args of cases) {
      const cap = io();
      const code = await runCli(args, cap.write);
      expect(code, `${args.join(" ")} 应退出 2`).toBe(EXIT_USAGE);
      expect(cap.err.join(""), `${args.join(" ")} 应给出错误说明`).not.toBe("");
    }
  });

  it("取值型 flag 缺值也是 2", async () => {
    withConfig();
    const cap = io();
    const code = await runCli(["run", "--config"], cap.write);
    expect(code).toBe(EXIT_USAGE);
    expect(cap.err.join("")).toContain("--config");
  });

  it("数字越界的策略值是 2 而不是 1", async () => {
    withConfig();
    // 给个假 Key 让配置检查先过，这样才能证明错的是数值范围本身
    process.env.LLM_API_KEY = "test-key-not-real";
    for (const args of [
      ["run", "--config", "config.json", "--max-attempts", "0"],
      ["run", "--config", "config.json", "--max-attempts", "6"],
      ["run", "--config", "config.json", "--max-attempts", "2.5"],
      ["run", "--config", "config.json", "--min-score", "101"],
      ["run", "--config", "config.json", "--max-repairs", "4"],
      ["run", "--config", "config.json", "--temperature", "abc"],
    ]) {
      const cap = io();
      const code = await runCli(args, cap.write);
      expect(code, `${args.join(" ")} 应退出 2`).toBe(EXIT_USAGE);
      // 错误信息要点名是哪个参数的问题，而不是笼统一句「运行失败」
      expect(cap.err.join("")).toContain(args[3]);
    }
  });

  it("修订 issue_type 不在白名单内是 2", async () => {
    withConfig();
    const cap = io();
    const code = await runCli(
      ["repair", "--config", "config.json", "--beats", "b.json", "--story", "s.md", "--issue-type", "不存在", "--issue-message", "x"],
      cap.write,
    );
    expect(code).toBe(EXIT_USAGE);
  });

  it("配置文件不存在或非法都是 2（不是运行时 1）", async () => {
    withTmpDir();
    const cap = io();
    const missing = await runCli(["validate", "--config", "nope.json", "--story", "s.md"], cap.write);
    expect(missing).toBe(EXIT_USAGE);

    const cap2 = io();
    const bad = await runCli(["validate", "--config", "@@", "--story", "s.md"], cap2.write);
    expect(bad).toBe(EXIT_USAGE);
  });

  it("没有 API Key 的 run 是配置错误 2，且不打印任何 Key 内容", async () => {
    withTmpDir();
    withConfig();
    const cap = io();
    const code = await runCli(["run", "--config", "config.json"], cap.write);
    expect(code).toBe(EXIT_USAGE);
    expect(cap.err.join("")).toContain("LLM_API_KEY");
    expect(cap.out.join("") + cap.err.join("")).not.toMatch(/sk-/);
  });
});

// ---------------------------------------------------------------------------
// 夹具：往临时目录写一份合法配置，并保证 LLM_API_KEY 状态可复现（§47）
// ---------------------------------------------------------------------------

const realKey = process.env.LLM_API_KEY;

function fresh() {
  const dir = withTmpDir();
  writeFileSync(join(dir, "config.json"), JSON.stringify(SAMPLE_CONFIG), "utf8");
  writeFileSync(join(dir, "s.md"), "# 消失的目击者\n\n正文。\n", "utf8");
  writeFileSync(join(dir, "b.json"), JSON.stringify(SAMPLE_BEAT_PLAN), "utf8");
  return dir;
}

afterEach(() => {
  if (realKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = realKey;
});

function withConfig() {
  const dir = fresh();
  delete process.env.LLM_API_KEY;
  return dir;
}
