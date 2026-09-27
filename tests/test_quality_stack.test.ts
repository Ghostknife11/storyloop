import { describe, expect, it } from "vitest";
import {
  QUALITY_STACK_SCHEMA_VERSION,
  QualityStackValidationError,
  qualityStackResultOf,
  qualityStackStatusOf,
  validateQualityStackResult,
  type QualityStackResult,
} from "@/domain/quality-stack";
import { QualityStackCoordinator } from "@/engine/quality-stack-coordinator";
import {
  SAMPLE_BEAT_VALIDATION_V2,
  SAMPLE_BEAT_VALIDATION_V2_FAILED,
  SAMPLE_COMMERCIAL_REVIEW_V2,
  qualityReviewV2Of,
} from "./helpers/fixtures";

/**
 * v2.1.0 Quality Stack：统一视图、合并诊断、severity 计数（TASK §21/§22/§23/§37/§42）。
 *
 * 真组件、纯函数：不接 LLM、不碰文件系统、不给 Story，也不看任何重试 / 修订字段——
 * §21 的「不能」清单在这里是靠输入形状保证的，不是靠自觉。
 */

const coordinator = new QualityStackCoordinator();

function stack(
  beatValidation: QualityStackResult["beatValidation"],
  qualityReview: QualityStackResult["qualityReview"],
  commercialReview: QualityStackResult["commercialReview"],
): QualityStackResult {
  return coordinator.coordinate({
    beatValidation: beatValidation ?? null,
    qualityReview: qualityReview ?? null,
    commercialReview: commercialReview ?? null,
  });
}

const ALL_IN = {
  beatValidation: SAMPLE_BEAT_VALIDATION_V2,
  qualityReview: qualityReviewV2Of(80),
  commercialReview: SAMPLE_COMMERCIAL_REVIEW_V2,
};

describe("§21 QualityStackCoordinator：只收集、合并、计数", () => {
  it("三套结论都在 → complete，三个模块原样收录", () => {
    const result = stack(ALL_IN.beatValidation, ALL_IN.qualityReview, ALL_IN.commercialReview);
    expect(result.status).toBe("complete");
    expect(result.schemaVersion).toBe(QUALITY_STACK_SCHEMA_VERSION);
    expect(result.beatValidation).toBe(ALL_IN.beatValidation);
    expect(result.qualityReview).toBe(ALL_IN.qualityReview);
    expect(result.commercialReview).toBe(ALL_IN.commercialReview);
  });

  it("§42 一套失败 → partial，缺哪一路就看得出是谁不在", () => {
    const onlyReview = stack(null, ALL_IN.qualityReview, null);
    expect(onlyReview.status).toBe("partial");
    expect(onlyReview.beatValidation).toBeUndefined();
    expect(onlyReview.qualityReview).toBe(ALL_IN.qualityReview);
    expect(onlyReview.commercialReview).toBeUndefined();

    const noCommercial = stack(ALL_IN.beatValidation, ALL_IN.qualityReview, null);
    expect(noCommercial.status).toBe("partial");
    expect(noCommercial.commercialReview).toBeUndefined();
  });

  it("§42 一套都不在 → failed，diagnostics 为空、计数全 0（不补假诊断）", () => {
    const result = stack(null, null, null);
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual([]);
    expect(result.summary).toEqual({ totalDiagnostics: 0, errors: 0, warnings: 0, info: 0 });
  });

  it("§22 status 八种在位组合全部由在位数量决定", () => {
    const cases: Array<[boolean, boolean, boolean, string]> = [
      [true, true, true, "complete"],
      [true, true, false, "partial"],
      [true, false, true, "partial"],
      [false, true, true, "partial"],
      [true, false, false, "partial"],
      [false, true, false, "partial"],
      [false, false, true, "partial"],
      [false, false, false, "failed"],
    ];
    for (const [beat, quality, commercial, status] of cases) {
      const modules = {
        beatValidation: beat ? SAMPLE_BEAT_VALIDATION_V2 : null,
        qualityReview: quality ? qualityReviewV2Of(80) : null,
        commercialReview: commercial ? SAMPLE_COMMERCIAL_REVIEW_V2 : null,
      };
      expect(qualityStackStatusOf(modules), `${beat}/${quality}/${commercial}`).toBe(status);
      expect(coordinator.coordinate(modules).status).toBe(status);
    }
  });

  it("§21 不重新评分：三个分数原样搬运，一个都没被重算", () => {
    const result = stack(ALL_IN.beatValidation, ALL_IN.qualityReview, ALL_IN.commercialReview);
    expect(result.qualityReview?.score).toBe(80);
    expect(result.commercialReview?.score).toBe(SAMPLE_COMMERCIAL_REVIEW_V2.score);
  });

  it("§21 确定性：同一输入两次，输出逐字相同", () => {
    const first = stack(ALL_IN.beatValidation, qualityReviewV2Of(72, ["中段重复"]), ALL_IN.commercialReview);
    const second = stack(ALL_IN.beatValidation, qualityReviewV2Of(72, ["中段重复"]), ALL_IN.commercialReview);
    expect(first).toEqual(second);
  });

  it("§21 输出里没有任何重试 / 修订 / 模型字段：诊断再多也驱动不了自动动作", () => {
    const result = stack(
      SAMPLE_BEAT_VALIDATION_V2_FAILED,
      qualityReviewV2Of(20, ["高潮缺失", "因果断裂"]),
      SAMPLE_COMMERCIAL_REVIEW_V2,
    );
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      "beatValidation", "commercialReview", "diagnostics", "qualityReview", "schemaVersion", "status", "summary",
    ]);
    for (const forbidden of ["retry", "repair", "model", "prompt", "story", "action", "rootCause"]) {
      expect(keys, `不该出现 ${forbidden}`).not.toContain(forbidden);
    }
    expect(JSON.stringify(result)).not.toMatch(/retry|repair/i);
  });
});

describe("§22/§23 合并诊断与计数", () => {
  it("按 beat → quality → commercial 顺序合并，三家一条不少", () => {
    const result = stack(
      SAMPLE_BEAT_VALIDATION_V2_FAILED,
      qualityReviewV2Of(72, [], ["中段两场戏功能重复"]),
      SAMPLE_COMMERCIAL_REVIEW_V2,
    );
    expect(result.diagnostics.map((d) => d.source)).toEqual([
      "beat-validator", "quality-reviewer", "commercial-reviewer",
    ]);
    expect(result.diagnostics.map((d) => d.id)).toEqual([
      "beat-validator-1", "quality-reviewer-1", "commercial-reviewer-1",
    ]);
  });

  it("§22 summary 按 severity 计数，总数等于 diagnostics 长度", () => {
    const result = stack(
      SAMPLE_BEAT_VALIDATION_V2_FAILED,
      qualityReviewV2Of(72, [], ["中段两场戏功能重复"]),
      SAMPLE_COMMERCIAL_REVIEW_V2,
    );
    expect(result.summary).toEqual({ totalDiagnostics: 3, errors: 1, warnings: 2, info: 0 });
    expect(result.summary.totalDiagnostics).toBe(result.diagnostics.length);
  });

  it("info / warning / error 三档各自计各自的数", () => {
    const review = qualityReviewV2Of(60, [], ["可优化一处"]);
    const result = stack(SAMPLE_BEAT_VALIDATION_V2_FAILED, review, null);
    // beat-validator-1 是 error；审阅那条建议型诊断是 warning
    expect(result.summary).toEqual({ totalDiagnostics: 2, errors: 1, warnings: 1, info: 0 });
  });

  it("§23 轻量去重：同一来源对同一处说的同一句话只留第一条", () => {
    const duplicated = qualityReviewV2Of(72, [], ["中段两场戏功能重复", "中段两场戏功能重复"]);
    const result = stack(null, duplicated, null);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.summary.totalDiagnostics).toBe(1);
  });

  it("§23 去重只按 source + category + target + message：换来源就不合并", () => {
    const beat = SAMPLE_BEAT_VALIDATION_V2_FAILED;
    // 同一句话由另一家说出来：来源不同（类别白名单本来就各认各的），两条都在
    const bothSaid = stack(beat, qualityReviewV2Of(72, [], [beat.diagnostics[0].message]), null);
    expect(bothSaid.diagnostics).toHaveLength(2);
    expect(bothSaid.summary.totalDiagnostics).toBe(2);
  });

  it("§23 没有语义合并：近似但不同的两句话都留着", () => {
    const result = stack(
      null,
      qualityReviewV2Of(72, [], ["中段两场戏功能重复", "中段两场戏功能重复。"]),
      null,
    );
    expect(result.diagnostics).toHaveLength(2);
  });
});

describe("§37/§22 quality-stack.json 的严格校验", () => {
  const complete = stack(ALL_IN.beatValidation, ALL_IN.qualityReview, ALL_IN.commercialReview);
  /** 三家各带一条诊断的一份：改诊断字段的用例都从它出发。 */
  const full = stack(
    SAMPLE_BEAT_VALIDATION_V2_FAILED,
    qualityReviewV2Of(80, [], ["中段两场戏功能重复"]),
    SAMPLE_COMMERCIAL_REVIEW_V2,
  );
  const fullRaw = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(full)) as Record<string, unknown>;

  it("协调器自己产出的结果原样通过校验", () => {
    expect(validateQualityStackResult(complete)).toEqual(complete);
    expect(qualityStackResultOf(JSON.parse(JSON.stringify(complete)))).toEqual(complete);
  });

  it("schemaVersion 不认 → 抛错（旧版本文件不当成新版读）", () => {
    expect(() => validateQualityStackResult({ ...complete, schemaVersion: "0" })).toThrow(
      QualityStackValidationError,
    );
    expect(() => validateQualityStackResult({ ...complete, schemaVersion: "0" })).toThrow(/schemaVersion/);
    expect(qualityStackResultOf({ ...complete, schemaVersion: "0" })).toBeNull();
  });

  it("status 不合法 → 抛错", () => {
    expect(() => validateQualityStackResult({ ...complete, status: "unknown" })).toThrow(/status/);
  });

  it("status 与在位的模块对不上 → 抛错（少了模块却自称 complete）", () => {
    const missing = { ...complete };
    delete (missing as Record<string, unknown>).commercialReview;
    expect(() => validateQualityStackResult(missing)).toThrow(/status 与在位的模块对不上/);
  });

  it("diagnostics 缺失或不是数组 → 抛错，不补空数组", () => {
    const raw = JSON.parse(JSON.stringify(complete)) as Record<string, unknown>;
    delete raw.diagnostics;
    expect(() => validateQualityStackResult(raw)).toThrow(/diagnostics 必须是数组/);
    expect(qualityStackResultOf(raw)).toBeNull();
  });

  it("summary 计数与 diagnostics 对不上 → 整份作废（手改过的计数不采信）", () => {
    const tampered = {
      ...complete,
      summary: { ...complete.summary, errors: 99 },
    };
    expect(() => validateQualityStackResult(tampered)).toThrow(/summary\.errors/);
    expect(qualityStackResultOf(tampered)).toBeNull();
  });

  it("模块键给 null 等于没给：不算一套结论", () => {
    const nulled = { ...complete, commercialReview: null };
    expect(() => validateQualityStackResult(nulled)).toThrow(/status 与在位的模块对不上/);
    const partial = stack(ALL_IN.beatValidation, ALL_IN.qualityReview, null);
    expect(validateQualityStackResult({ ...partial, commercialReview: null })).toEqual(partial);
  });

  it("模块结论本身不合法 → 指名是哪一个模块，不整体含糊过去", () => {
    const dimensions = complete.qualityReview!.dimensions;
    const broken = {
      ...complete,
      qualityReview: {
        ...complete.qualityReview!,
        dimensions: { ...dimensions, causality: { ...dimensions.causality, score: 999 } },
      },
    };
    expect(() => validateQualityStackResult(broken)).toThrow(/qualityReview 不是合法的结论/);
    expect(() => validateQualityStackResult(broken)).toThrow(/causality/);
  });

  it("诊断的 category 写进别家的白名单 → 拒绝（两套评价不做换算）", () => {
    const raw = fullRaw();
    const diagnostics = raw.diagnostics as Array<Record<string, unknown>>;
    diagnostics[2].category = "weak_climax"; // 商业诊断写了故事质量类别
    expect(() => validateQualityStackResult(raw)).toThrow(/category 非法/);
    expect(qualityStackResultOf(raw)).toBeNull();
  });

  it("诊断 id 不是那家指的 → 拒绝（UI 定位与 FailureAnalyzer 指向会对不上）", () => {
    const raw = JSON.parse(JSON.stringify(complete)) as Record<string, unknown>;
    const diagnostics = raw.diagnostics as Array<Record<string, unknown>>;
    diagnostics[0].id = "someone-else-1";
    expect(() => validateQualityStackResult(raw)).toThrow(/diagnostics\.id/);
  });

  it("读旧 / 坏数据只给 null：半份 JSON、字符串、null 都不补总览", () => {
    expect(qualityStackResultOf(null)).toBeNull();
    expect(qualityStackResultOf("{ not json")).toBeNull();
    expect(qualityStackResultOf("{}")).toBeNull();
    expect(qualityStackResultOf([])).toBeNull();
  });
});
