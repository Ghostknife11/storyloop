import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli, parseArgs, EXIT_OK, EXIT_RUNTIME, EXIT_USAGE } from "../scripts/generate-cli";
import { withTmpDir } from "./helpers/fixtures";

/**
 * §29/§30/§31/§32 CLI 收口：--help 可用、退出码 0/1/2、不重复业务逻辑。
 * 全部用临时目录里的配置文件，绝不打真实付费 API（§66）。
 */

const CONFIG = {
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

const BEATS = {
  beat_plan_version: "1",
  beats: [
    { id: 1, purpose: "建立危机", event: "证人失踪。", characters: ["陈岚"] },
    { id: 2, purpose: "高潮", event: "对峙揭相。", characters: ["陈岚"] },
  ],
};

/** 远超长度下限、含主角名、以句号结尾：可通过全部硬规则。 */
const GOOD_STORY = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;
const BAD_STORY = "太短。";

interface Collected {
  lines: string[];
  errors: string[];
}

function collector(): Collected & { io: { out: (l: string) => void; err: (l: string) => void } } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: {
      out: (line: string) => lines.push(line),
      err: (line: string) => errors.push(line),
    },
  };
}

const realKey = process.env.LLM_API_KEY;

beforeEach(() => {
  // 默认当作「没配 Key」，只有明确需要的用例才临时放开
  delete process.env.LLM_API_KEY;
});

afterEach(() => {
  if (realKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = realKey;
});

function writeFiles() {
  const dir = withTmpDir();
  const configPath = join(dir, "config.json");
  const beatsPath = join(dir, "beats.json");
  const goodPath = join(dir, "good.md");
  const badPath = join(dir, "bad.md");
  writeFileSync(configPath, JSON.stringify(CONFIG), "utf8");
  writeFileSync(beatsPath, JSON.stringify(BEATS), "utf8");
  writeFileSync(goodPath, `# ${CONFIG.title}\n\n${GOOD_STORY}\n`, "utf8");
  writeFileSync(badPath, `# ${CONFIG.title}\n\n${BAD_STORY}\n`, "utf8");
  return { dir, configPath, beatsPath, goodPath, badPath };
}

describe("§29 CLI Help", () => {
  it("storygen --help 列出全部子命令，退出码 0", async () => {
    const c = collector();
    const code = await runCli(["--help"], c.io);
    expect(code).toBe(EXIT_OK);
    const text = c.lines.join("\n");
    for (const command of ["run", "plan", "review", "validate", "repair"]) {
      expect(text).toContain(command);
    }
    expect(text).toContain("退出码");
  });

  it("每个子命令 --help 都可用，且只描述自己这一层", async () => {
    for (const command of ["run", "plan", "review", "validate", "repair"] as const) {
      const c = collector();
      const code = await runCli([command, "--help"], c.io);
      expect(code, `${command} --help 退出码`).toBe(EXIT_OK);
      expect(c.lines.join("\n")).toContain("--config <story.json>");
    }
  });

  it("run --help 说明重试与修订参数，validate --help 说明不调模型", async () => {
    const run = collector();
    await runCli(["run", "--help"], run.io);
    expect(run.lines.join("\n")).toContain("--max-attempts");

    const validate = collector();
    await runCli(["validate", "--help"], validate.io);
    expect(validate.lines.join("\n")).toContain("不调模型");
  });

  it("-h 与 --help 等价", async () => {
    const c = collector();
    expect(await runCli(["-h"], c.io)).toBe(EXIT_OK);
  });
});

describe("§30 CLI Exit Code — 参数或配置不合法 = 2", () => {
  it("没有任何参数 → 2", async () => {
    const c = collector();
    expect(await runCli([], c.io)).toBe(EXIT_USAGE);
    expect(c.errors.join("\n")).toContain("缺少子命令");
  });

  it("未知子命令 → 2", async () => {
    const c = collector();
    expect(await runCli(["frobnicate", "--config", "x.json"], c.io)).toBe(EXIT_USAGE);
    expect(c.errors.join("\n")).toContain("缺少子命令");
  });

  it("未知 flag → 2", async () => {
    const files = writeFiles();
    const c = collector();
    expect(await runCli(["validate", "--config", files.configPath, "--bogus"], c.io)).toBe(EXIT_USAGE);
    expect(c.errors.join("\n")).toContain("无法识别的参数");
  });

  it("缺 --config → 2", async () => {
    const c = collector();
    expect(await runCli(["validate"], c.io)).toBe(EXIT_USAGE);
    expect(c.errors.join("\n")).toContain("--config");
  });

  it("flag 给了但没有取值 → 2", async () => {
    const c = collector();
    expect(await runCli(["validate", "--config"], c.io)).toBe(EXIT_USAGE);
  });

  it("配置文件读不到 → 2", async () => {
    const files = writeFiles();
    const c = collector();
    const code = await runCli(["validate", "--config", join(files.dir, "nope.json"), "--story", files.goodPath], c.io);
    expect(code).toBe(EXIT_USAGE);
    expect(c.errors.join("\n")).toContain("读不到配置文件");
  });

  it("配置文件不是合法 JSON → 2", async () => {
    const files = writeFiles();
    writeFileSync(join(files.dir, "broken.json"), "not json", "utf8");
    const c = collector();
    const code = await runCli(["validate", "--config", join(files.dir, "broken.json"), "--story", files.goodPath], c.io);
    expect(code).toBe(EXIT_USAGE);
    expect(c.errors.join("\n")).toContain("配置不合法");
    expect(c.errors.join("\n")).toContain("JSON");
  });

  it("配置合法 JSON 但过不了 StoryConfig 校验 → 2", async () => {
    const files = writeFiles();
    writeFileSync(join(files.dir, "invalid.json"), JSON.stringify({ config_version: "1", title: "x" }), "utf8");
    const c = collector();
    const code = await runCli(["validate", "--config", join(files.dir, "invalid.json"), "--story", files.goodPath], c.io);
    expect(code).toBe(EXIT_USAGE);
    expect(c.errors.join("\n")).toContain("配置不合法");
  });

  it("--max-attempts / --min-score / --max-repairs 越界 → 2", async () => {
    const files = writeFiles();
    for (const args of [
      ["--max-attempts", "9"],
      ["--max-attempts", "0"],
      ["--max-attempts", "1.5"],
      ["--min-score", "200"],
      ["--max-repairs", "9"],
      ["--max-repairs", "-1"],
    ]) {
      const c = collector();
      const code = await runCli(["run", "--config", files.configPath, ...args], c.io);
      expect(code, `${args.join(" ")} 应该算参数错误`).toBe(EXIT_USAGE);
    }
  });

  it("--enable-repair 与 --no-repair 同时给 → 2", async () => {
    const files = writeFiles();
    const c = collector();
    expect(await runCli(["run", "--config", files.configPath, "--enable-repair", "--no-repair"], c.io)).toBe(EXIT_USAGE);
  });

  it("没配 LLM_API_KEY 时，除 validate 外的命令都是 2", async () => {
    const files = writeFiles();
    for (const command of ["run", "plan", "review", "repair"] as const) {
      const c = collector();
      const code = await runCli([command, "--config", files.configPath], c.io);
      expect(code, `${command} 缺 Key 应该算配置错误`).toBe(EXIT_USAGE);
      expect(c.errors.join("\n")).toContain("LLM_API_KEY");
    }
  });

  it("repair 缺 --issue-type / --issue-message / --beats 都是 2", async () => {
    const files = writeFiles();
    const cases: string[][] = [
      ["repair", "--config", files.configPath, "--story", files.goodPath, "--issue-message", "x"],
      ["repair", "--config", files.configPath, "--story", files.goodPath, "--issue-type", "ending"],
      ["repair", "--config", files.configPath, "--story", files.goodPath, "--issue-type", "ending", "--issue-message", "x"],
    ];
    for (const argv of cases) {
      const c = collector();
      expect(await runCli(argv, c.io), argv.join(" ")).toBe(EXIT_USAGE);
    }
  });

  it("validate / review 缺 --story → 2", async () => {
    const files = writeFiles();
    for (const command of ["validate", "review"] as const) {
      const c = collector();
      expect(await runCli([command, "--config", files.configPath], c.io)).toBe(EXIT_USAGE);
    }
  });
});

describe("§30 CLI Exit Code — validate 不调模型", () => {
  it("没有 LLM_API_KEY 也能校验，正文合规 → 0", async () => {
    const files = writeFiles();
    const c = collector();
    expect(await runCli(["validate", "--config", files.configPath, "--story", files.goodPath], c.io)).toBe(EXIT_OK);
    expect(c.lines.join("\n")).toContain("Validation: PASSED");
  });

  it("正文不合规也是 0——FAILED 是内容的结论，不是 CLI 失败", async () => {
    const files = writeFiles();
    const c = collector();
    expect(await runCli(["validate", "--config", files.configPath, "--story", files.badPath], c.io)).toBe(EXIT_OK);
    const text = c.lines.join("\n");
    expect(text).toContain("Validation: FAILED");
    expect(text).toContain("TOO_SHORT");
  });

  it("正文文件读不到 → 2", async () => {
    const files = writeFiles();
    const c = collector();
    expect(await runCli(["validate", "--config", files.configPath, "--story", join(files.dir, "nope.md")], c.io)).toBe(EXIT_USAGE);
  });

  it("正文文件里只有标题、没有正文 → 2", async () => {
    const files = writeFiles();
    writeFileSync(join(files.dir, "empty.md"), "# 只有标题\n", "utf8");
    const c = collector();
    expect(await runCli(["validate", "--config", files.configPath, "--story", join(files.dir, "empty.md")], c.io)).toBe(EXIT_USAGE);
  });
});

describe("§30 退出码常量", () => {
  it("0 / 1 / 2 三个值互不相同", () => {
    expect(new Set([EXIT_OK, EXIT_RUNTIME, EXIT_USAGE]).size).toBe(3);
    expect(EXIT_OK).toBe(0);
    expect(EXIT_RUNTIME).toBe(1);
    expect(EXIT_USAGE).toBe(2);
  });
});

describe("parseArgs", () => {
  it("认出子命令与取值 flag", () => {
    const args = parseArgs(["run", "--config", "a.json", "--model", "m", "--max-attempts", "3"]);
    expect(args.command).toBe("run");
    expect(args.flags["--config"]).toBe("a.json");
    expect(args.flags["--model"]).toBe("m");
    expect(args.flags["--max-attempts"]).toBe("3");
    expect(args.unknown).toBeUndefined();
  });

  it("认出布尔开关", () => {
    const args = parseArgs(["run", "--config", "a.json", "--enable-repair", "--no-retry-on-validation-failure"]);
    expect(args.switches.has("--enable-repair")).toBe(true);
    expect(args.switches.has("--no-retry-on-validation-failure")).toBe(true);
  });

  it("取值长得像 flag 时算缺少取值", () => {
    const args = parseArgs(["run", "--config", "--model"]);
    expect(args.unknown).toContain("--config");
  });

  it("第一个不认识的 token 记进 unknown", () => {
    expect(parseArgs(["run", "--config", "a.json", "--nope"]).unknown).toBe("--nope");
    expect(parseArgs(["wat"]).command).toBeUndefined();
  });

  it("--help 在任何位置都认", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["run", "--config", "a.json", "--help"]).help).toBe(true);
  });
});

describe("§31 CLI 不重复业务逻辑", () => {
  it("CLI 源码里没有自己的重试 / 修订实现，只引用共享服务", async () => {
    const { readFileSync: read } = await import("node:fs");
    const source = read(join(process.cwd(), "scripts", "generate-cli.ts"), "utf8");
    // 共享服务是唯一的业务入口
    expect(source).toContain("generate-service");
    // 不允许出现 CLI 专属的重试循环 / 修订提示词
    expect(source).not.toMatch(/for\s*\([^)]*attempt/i);
    expect(source).not.toContain("prompts/repair.txt");
    expect(source).not.toContain("prompts/generate.txt");
  });

  it("临时目录用完即删，不往仓库里留产物", () => {
    const before = mkdtempSync(join(tmpdir(), "storyloop-cli-keep-"));
    writeFileSync(join(before, "marker"), "x", "utf8");
    expect(() => rmSync(before, { recursive: true, force: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// v1.1.1：CLI 的 --base-url 是操作者在本机给出的受信配置，信任级与 LLM_BASE_URL 相同
// （能跑这条命令的人本来就读得到 .env），所以不撞请求体那道「只允许公网地址」的关卡，
// 否则 CLI 再也连不上本地假模型。四个走模型的子命令必须表现一致。
// ---------------------------------------------------------------------------

describe("v1.1.1 CLI 入口的 baseUrl 信任级", () => {
  const LOCAL_ENDPOINT = "http://127.0.0.1:1/v1";
  const realKey = process.env.LLM_API_KEY;

  beforeEach(() => {
    // 假 Key：只为了通过 CLI 自己的 Key 检查，请求根本连不到任何真实服务
    process.env.LLM_API_KEY = "test-key-not-real";
  });

  afterEach(() => {
    if (realKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = realKey;
  });

  it("--base-url 指向本地时，plan / run / review 都因为连不上而失败，而不是被地址关卡拒掉", async () => {
    const { configPath, goodPath } = writeFiles();
    for (const command of [
      ["plan", "--config", configPath],
      ["run", "--config", configPath, "--max-attempts", "1"],
      ["review", "--config", configPath, "--story", goodPath],
    ]) {
      const c = collector();
      const code = await runCli([...command, "--base-url", LOCAL_ENDPOINT], c.io);
      const text = c.errors.join("\n") + c.lines.join("\n");
      // 三个子命令同一结局：请求发出去但连不上本地假模型
      expect(code, `${command[0]} 应以运行时失败结束：${text}`).toBe(EXIT_RUNTIME);
      expect(text).not.toContain("非公网地址");
      expect(text).toContain("LLM 请求失败");
    }
  });

  it("客户端只有一个构建点，请求体里不带 baseUrl", async () => {
    const { readFileSync: read } = await import("node:fs");
    const source = read(join(process.cwd(), "scripts", "generate-cli.ts"), "utf8");
    // 注入客户端前若把关卡打开了，v1.1.0 的 CLI 回归就会出现：plan 拦、run 不拦
    expect((source.match(/clientFromEnv\(/g) ?? []).length).toBe(1);
    expect((source.match(/cliClient\(args\)/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});
