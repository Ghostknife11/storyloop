import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as getExperiment } from "@/app/api/experiments/[experiment_id]/route";
import { runExperimentById } from "@/lib/experiment-service";
import { ExperimentStore } from "@/storage/experiment-store";
import { ExperimentStateError } from "@/types/experiment";
import { SAMPLE_BEAT_PLAN } from "./helpers/fixtures";
import type { LLMClient } from "@/lib/llm";
import type { ExperimentDefinition } from "@/types/experiment";
import type { StoryConfig } from "@/types/story-config";

/**
 * v1.7.1 补的两道闸门：id 不像目录名 → 404；同一实验同时只跑一条链。
 *
 * 两条都是 v1.7.0 审出来的真问题：
 *   - `GET /api/experiments/exp/../../x` 曾一路走到 500（ExperimentWriteError
 *     没有对应的错误码映射），而按契约「找不到」就该是 404；
 *   - 两个并发 `POST .../run` 曾双双通过预检，把同一个实验跑两遍——两倍付费请求。
 */

const CONFIG: StoryConfig = {
  config_version: "1",
  title: "消失的目击者",
  genre: "悬疑",
  premise: "唯一证人在出庭前一天突然消失。",
  target_words: 5000,
  protagonist: { name: "陈岚" },
};

/** 一个每格都耗一会儿的假模型：用来把第一次执行按在「正在跑」状态里。 */
function slowLLM(delayMs = 30): LLMClient {
  return {
    async generate() {
      await new Promise((r) => setTimeout(r, delayMs));
      throw new Error("这一组用例不看结果，只看闸门");
    },
  } as unknown as LLMClient;
}

const DEFINITION = {
  schemaVersion: "1",
  experimentId: "exp-guard",
  name: "闸门",
  base: { storyConfig: CONFIG, beatPlanMode: "fixed" as const, beatPlan: SAMPLE_BEAT_PLAN },
  variants: [{ id: "v1", name: "变体一", overrides: {} }],
  repetitions: 1,
  createdAt: "2026-09-26T00:00:00.000Z",
} as unknown as ExperimentDefinition;

const realCwd = process.cwd();
let tmp: string | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "exp-guard-"));
  process.chdir(tmp as string);
  mkdirSync(join(tmp, "runs"), { recursive: true });
});
afterEach(() => {
  process.chdir(realCwd);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function ctx(id: string) {
  return { params: Promise.resolve({ experiment_id: id }) } as never;
}

async function seed(id: string): Promise<void> {
  const store = new ExperimentStore("runs");
  store.createExperimentDirectory(id);
  store.putDefinition(id, DEFINITION);
}

describe("id 不像目录名 → 404，不进路径解析", () => {
  it("这些 id 全部 404，没有一个是 500", async () => {
    const bad = ["exp/../../x", "..", ".", "", "..%2F..%2Fetc", "a/b", ".hidden", "-dash", "con dup"];
    for (const id of bad) {
      const res = await getExperiment(new NextRequest("http://localhost/api/experiments/x"), ctx(id));
      expect(res.status, `id=${JSON.stringify(id)}`).toBe(404);
    }
  });

  it("合法 id 但实验不存在也是 404", async () => {
    const res = await getExperiment(new NextRequest("http://localhost/api/experiments/x"), ctx("nope-404"));
    expect(res.status).toBe(404);
  });

  it("真的建了就能读到（证明上面不是「一律 404」）", async () => {
    await seed("exp-guard");
    const res = await getExperiment(new NextRequest("http://localhost/api/experiments/x"), ctx("exp-guard"));
    expect(res.status).toBe(200);
  });
});

describe("同一实验同一时间只跑一条链", () => {
  it("并发第二个 runExperimentById 抛 EXPERIMENT_CONFLICT，且没有第二次执行", async () => {
    await seed("exp-guard");
    let calls = 0;
    const llm = {
      async generate() {
        calls += 1;
        await new Promise((r) => setTimeout(r, 40));
        throw new Error("不看结果，只看闸门");
      },
    } as unknown as LLMClient;

    const first = runExperimentById("exp-guard", { llm });
    const second = await runExperimentById("exp-guard", { llm }).catch((e) => e);
    await first.catch(() => undefined);

    expect(second).toBeInstanceOf(ExperimentStateError);
    expect((second as Error).message).toContain("正在运行中");
    // 第一个执行链自己发出去的请求才算数；第二个一个请求都没发
    expect(calls).toBeGreaterThan(0);
  });

  it("执行链结束（哪怕是失败）之后锁会还回去：再跑撞的是「已经跑过」而不是「正在运行中」", async () => {
    await seed("exp-guard");
    // 第一次：样本全失败，但照样收尾写出 results.json
    const first = await runExperimentById("exp-guard", { llm: slowLLM(1) });
    expect(first.status).toBe("failed");
    // 第二次：锁已释放，于是走到「结果不可变」那道闸门
    const again = await runExperimentById("exp-guard", { llm: slowLLM(1) }).catch((e) => e);
    expect(again).toBeInstanceOf(ExperimentStateError);
    expect((again as Error).message).toContain("已经跑过");
    expect((again as Error).message).not.toContain("正在运行中");
  });
});
