import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST as postValidate } from "@/app/api/validate/route";
import { validateStoryConfig, type StoryConfig } from "@/types/story-config";
import type { ValidationResult } from "@/types/validation-result";
import { apiErrorOf } from "./helpers/fixtures";

/**
 * §27/§42 POST /api/validate HTTP 路由层与服务层：只验证「JSON 解析 → 委托 service → 响应形状」。
 * §3 Validator 是纯规则，不调用 LLM，因此这里不需要 stub fetch。
 */

const config: StoryConfig = validateStoryConfig({
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
});

/** 长度足够、含主角名、以句号结尾：应通过全部硬规则。 */
const goodStory = `陈岚推开派出所的玻璃门，${"雨水顺着屋檐砸在台阶上。".repeat(80)}`;

const realCwd = process.cwd();
let tmp: string | null = null;
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

function withTmpDir() {
  tmp = mkdtempSync(join(tmpdir(), "storyloop-validate-api-"));
  process.chdir(tmp);
  return tmp;
}

function post(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new NextRequest("http://localhost/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

async function readJson(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("POST /api/validate（§27/§42）", () => {
  it("§42 valid story → passed", async () => {
    withTmpDir();
    const res = await postValidate(post({ config, story: goodStory }));
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ passed: true, issues: [] });
  });

  it("§42 invalid story → failed + 具体 issue", async () => {
    withTmpDir();
    const res = await postValidate(post({ config, story: "只有一句话。" }));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const validation = body as unknown as ValidationResult;
    expect(validation.passed).toBe(false);
    expect(validation.issues.map((i) => i.code)).toContain("TOO_SHORT");
    expect(validation.issues[0].severity).toBe("error");
    expect(validation.issues[0].message).toBeTruthy();
  });

  it("§42 missing story → request error（400）", async () => {
    withTmpDir();
    const res = await postValidate(post({ config }));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("story is required");
  });

  it("story 不是字符串 → 400", async () => {
    withTmpDir();
    const res = await postValidate(post({ config, story: 42 }));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("story is required");
  });

  it("§10/§16 空白正文是内容层面的硬失败 → 200 + EMPTY_CONTENT（不是请求错误）", async () => {
    withTmpDir();
    for (const story of ["", "   ", "\n\t "]) {
      const res = await postValidate(post({ config, story }));
      expect(res.status).toBe(200);
      const validation = (await readJson(res)) as unknown as ValidationResult;
      expect(validation.passed).toBe(false);
      expect(validation.issues.map((i) => i.code)).toEqual(["EMPTY_CONTENT"]);
      expect(validation.issues[0].severity).toBe("error");
    }
  });

  it("config 非法 → 400", async () => {
    withTmpDir();
    const res = await postValidate(post({
      config: { title: "", genre: "悬疑", premise: "x", target_words: 5000 },
      story: goodStory,
    }));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("标题");
  });

  it("§26 legacy {title, prompt} 请求体同样可用", async () => {
    withTmpDir();
    const res = await postValidate(post({ title: "旧请求", prompt: "一个旧格式请求。", story: goodStory }));
    expect(res.status).toBe(200);
    expect((await readJson(res)).passed).toBe(true);
  });

  it("§27 带 run_id 时覆盖该 Run 的 validation.json", async () => {
    const dir = withTmpDir();
    // 手工造一个 Run 目录（Validator 不需要 LLM，因此不必跑完整 Run）
    const runId = "20260101_000000_aaaaaa";
    const runDir = join(dir, "runs", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "validation.json"), JSON.stringify({ passed: true, issues: [] }), "utf8");

    const res = await postValidate(post({ config, story: "只有一句话。", run_id: runId }));
    expect(res.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(runDir, "validation.json"), "utf8")) as ValidationResult;
    expect(saved.passed).toBe(false);
    expect(saved.issues.map((i) => i.code)).toContain("TOO_SHORT");
    // §27：只覆盖，不建立 validation_history / validation_v1
    expect(readdirSync(runDir).filter((f) => f.startsWith("validation"))).toEqual(["validation.json"]);
  });

  it("run_id 越界（..）被拒绝，不会写到 runs 之外", async () => {
    withTmpDir();
    const res = await postValidate(post({ config, story: goodStory, run_id: "../../evil" }));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("run_id 非法");
    expect(existsSync(join(tmp as string, "evil"))).toBe(false);
  });

  it("run_id 不存在 → 400（不静默丢弃）", async () => {
    withTmpDir();
    const res = await postValidate(post({ config, story: goodStory, run_id: "20260101_000000_zzzzzz" }));
    expect(res.status).toBe(404);
    expect(apiErrorOf(await readJson(res)).code).toBe("RUN_NOT_FOUND");
  });

  it("请求体不是合法 JSON → 400", async () => {
    withTmpDir();
    const res = await postValidate(post("{oops"));
    expect(res.status).toBe(400);
    expect(apiErrorOf(await readJson(res)).message).toContain("JSON");
  });

  it("§2/§59 不调用 Reviewer：响应里没有 score / summary 等评价字段", async () => {
    withTmpDir();
    const res = await postValidate(post({ config, story: goodStory }));
    const body = await readJson(res);
    for (const forbidden of ["score", "summary", "strengths", "problems", "review"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(Object.keys(body).sort()).toEqual(["issues", "passed"]);
  });

  it("§58 校验失败也不返回任何修复后的正文", async () => {
    withTmpDir();
    const res = await postValidate(post({ config, story: "太短" }));
    const body = await readJson(res);
    for (const forbidden of ["fixed_story", "revised_story", "patched_story", "story", "suggestion"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});
