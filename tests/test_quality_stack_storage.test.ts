import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GenerationPipeline } from "@/engine/pipeline";
import { DEFAULT_RETRY_POLICY } from "@/engine/retry-policy";
import { ArtifactStore } from "@/infrastructure/storage/artifact-store";
import { QualityStackCoordinator } from "@/engine/quality-stack-coordinator";
import { QualityStackValidationError, validateQualityStackResult } from "@/domain/quality-stack";
import type { QualityStackResult } from "@/domain/quality-stack";
import {
  SAMPLE_BEAT_PLAN,
  SAMPLE_BEAT_VALIDATION_V2,
  SAMPLE_COMMERCIAL_REVIEW_V2,
  SAMPLE_CONFIG,
  SAMPLE_QUALITY_REVIEW_V2,
  SAMPLE_STORY,
  SAMPLE_VALIDATION,
  withTmpDir,
} from "./helpers/fixtures";

/**
 * v2.1.0 TASK §24/§25 quality-stack.json 的落盘契约。
 *
 * 四件事必须都是真话，否则这份「统一视图」比没有更糟：
 *   1. 它在 Run 根目录，且只在那儿——不进 attempts/，也不被 promote 复制；
 *   2. 写盘走严格校验（§37）：status 与在位模块对不上、summary 与 diagnostics 对不上，
 *      一律在写盘那一刻抛错，不留给读者去猜；
 *   3. 读盘走宽容版：文件缺失 / JSON 坏 / 形状不对都归一成 null，
 *      于是 v2.0.0 及更早的 Run 照旧能加载（§27）；
 *   4. 它是**新增**：写完它，beat-validation.json / review.json / quality.json /
 *      commercial-review.json 一个字节都不能被动过（§24）。
 *
 * 全部用 FakeLLM 与假组件，绝不打真实付费 API。
 */

/** 三套结论齐全的一份栈——对应 §22 的 complete。 */
function fullStack(): QualityStackResult {
  return new QualityStackCoordinator().coordinate({
    beatValidation: SAMPLE_BEAT_VALIDATION_V2,
    qualityReview: SAMPLE_QUALITY_REVIEW_V2,
    commercialReview: SAMPLE_COMMERCIAL_REVIEW_V2,
  });
}

describe("quality-stack.json 落盘（§24/§25）", () => {
  it("写进去的与读回来的一模一样，文件就在 Run 根目录", () => {
    withTmpDir();
    const store = new ArtifactStore();
    const runId = "20260927_000000_qs01";
    store.createRunDirectory(runId);

    const stack = fullStack();
    expect(stack.status).toBe("complete");
    store.putQualityStack(runId, stack);

    expect(existsSync(join(store.resolveRunDir(runId), "quality-stack.json"))).toBe(true);
    // 读回来的与交上去的逐字相同：装配器算出来的 status / summary 不被改写
    expect(store.readQualityStack(runId)).toEqual(stack);
  });

  it("status 与在位模块对不上：写盘那一刻就抛，盘上不留下半份", () => {
    withTmpDir();
    const store = new ArtifactStore();
    const runId = "20260927_000000_qs02";
    store.createRunDirectory(runId);

    const lying = { ...fullStack(), status: "failed" } as unknown as QualityStackResult;
    expect(() => store.putQualityStack(runId, lying)).toThrow(QualityStackValidationError);
    // 抛错的那一次没有落盘：读者不会读到一份自称 failed 的半成品
    expect(existsSync(join(store.resolveRunDir(runId), "quality-stack.json"))).toBe(false);
  });

  it("summary 计数与 diagnostics 对不上：同样在写盘前被拦下", () => {
    withTmpDir();
    const store = new ArtifactStore();
    const runId = "20260927_000000_qs03";
    store.createRunDirectory(runId);

    const stack = fullStack();
    const tampered = {
      ...stack,
      summary: { ...stack.summary, totalDiagnostics: stack.summary.totalDiagnostics + 1 },
    } as unknown as QualityStackResult;
    expect(() => store.putQualityStack(runId, tampered)).toThrow(/totalDiagnostics/);
  });

  it("读盘宽容：文件缺失 / JSON 坏 / 形状不对都是 null，旧 Run 照常加载", () => {
    withTmpDir();
    const store = new ArtifactStore();
    const runId = "20260927_000000_qs04";
    store.createRunDirectory(runId);
    const file = join(store.resolveRunDir(runId), "quality-stack.json");

    // v2.0.0 的 Run 没有这份文件
    expect(store.readQualityStack(runId)).toBeNull();

    writeFileSync(file, "{ 这不是 JSON", "utf8");
    expect(store.readQualityStack(runId)).toBeNull();

    // 缺 diagnostics / summary：形状不对，同样不补一个空数组糊弄
    writeFileSync(file, JSON.stringify({ schemaVersion: "1", status: "complete" }), "utf8");
    expect(store.readQualityStack(runId)).toBeNull();

    // 将来的 schemaVersion：这一版读不出来，但也不许崩
    writeFileSync(file, JSON.stringify({ ...fullStack(), schemaVersion: "2" }), "utf8");
    expect(store.readQualityStack(runId)).toBeNull();
    expect(() => validateQualityStackResult({ ...fullStack(), schemaVersion: "2" })).toThrow(
      QualityStackValidationError,
    );
  });

  it("写完它，四份旧产物一个字节都没被动过（§24 不是替换层）", () => {
    withTmpDir();
    const store = new ArtifactStore();
    const runId = "20260927_000000_qs05";
    store.createRunDirectory(runId);
    const dir = store.resolveRunDir(runId);

    const old = ["beat-validation.json", "review.json", "quality.json", "commercial-review.json"];
    for (const name of old) {
      writeFileSync(join(dir, name), `{"name":"${name}"}`, "utf8");
    }
    const before = old.map((name) => readFileSync(join(dir, name), "utf8"));

    store.putQualityStack(runId, fullStack());

    expect(old.map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(before);
    // 四份都在，另外多出来的是统一视图自己
    expect(readdirSync(dir).sort()).toEqual([...old, "quality-stack.json"].sort());
  });
});

describe("真实 Pipeline 落一份 quality-stack.json（§24/§25）", () => {
  function pipelineOf(store: ArtifactStore, commercial: boolean) {
    // 位置参数对应构造器签名：… beatValidator、commercialReviewer 之后就是默认值
    return new GenerationPipeline(
      { plan: async () => SAMPLE_BEAT_PLAN } as never,
      { generate: async () => SAMPLE_STORY } as never,
      { validate: async () => SAMPLE_VALIDATION } as never,
      { review: async () => SAMPLE_QUALITY_REVIEW_V2 } as never,
      store,
      DEFAULT_RETRY_POLICY,
      undefined,
      undefined,
      undefined,
      undefined,
      { validate: async () => SAMPLE_BEAT_VALIDATION_V2 } as never,
      commercial ? ({ review: async () => SAMPLE_COMMERCIAL_REVIEW_V2 } as never) : undefined,
    );
  }

  it("三套组件都跑成：根目录多一份 status=complete 的统一视图，attempts/ 里没有它", async () => {
    withTmpDir();
    const store = new ArtifactStore();
    const result = await pipelineOf(store, true).run(SAMPLE_CONFIG);
    const dir = store.resolveRunDir(result.run_id);

    const stack = store.readQualityStack(result.run_id);
    expect(stack?.status).toBe("complete");
    // §25：只在运行级——promote 不复制它，attempts/01 里一个都没有
    expect(readdirSync(join(dir, "attempts", "01"))).not.toContain("quality-stack.json");
    // §24：旧产物一个都没少
    for (const name of ["beat-validation.json", "review.json", "quality.json", "commercial-review.json"]) {
      expect(existsSync(join(dir, name)), name).toBe(true);
    }
    // 栈里那份审阅分与 metadata 的 review_score 是同一个数（不重新评分）
    const meta = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")) as { review_score: number };
    expect(stack?.qualityReview?.score).toBe(meta.review_score);
    expect(stack?.commercialReview?.score).toBe(71.5);
  });

  it("商业审阅这一路没接：栈里没有那一份，status 落在 partial，其余照旧", async () => {
    withTmpDir();
    const store = new ArtifactStore();
    const result = await pipelineOf(store, false).run(SAMPLE_CONFIG);

    const stack = store.readQualityStack(result.run_id);
    expect(stack?.status).toBe("partial");
    expect(stack?.commercialReview).toBeUndefined();
    expect(stack?.qualityReview).not.toBeNull();
    // §36：具体模块状态保留在 metadata 里，与栈的说法一致
    const meta = JSON.parse(
      readFileSync(join(store.resolveRunDir(result.run_id), "metadata.json"), "utf8"),
    ) as { commercial_review_status: string };
    expect(meta.commercial_review_status).toBe("not_started");
  });
});
