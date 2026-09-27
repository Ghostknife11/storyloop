/**
 * v2.1.0 QualityStackCoordinator：把三套已经跑完的质量结论收成一张统一视图
 * （TASK §21/§22/§23/§24）。
 *
 * 职责只有四件事：收集三套结果、统一 diagnostics、做轻量去重、生成 QualityStackResult。
 * 统一 API / Artifact 输出由调用方（Application / Infrastructure）按这个结果去写，
 * 协调器自己不碰文件、不发请求。
 *
 * 明确不做（TASK §21/§28）：
 *   - 不调用 LLM：输入里没有任何客户端，也没有可以调用的入口；
 *   - 不重新评分：三个 score 原样搬运，这里只做 severity 计数；
 *   - 不修改 Story：输入里没有 Story；
 *   - 不决定 Retry / Repair：输出里没有重试、修订、模型或提示词相关的任何字段。
 *
 * 因此它是纯函数式的：同样的三套结论进来，永远得到同一份 QualityStackResult，
 * 可以随时重算、随时对拍。
 */

import {
  qualityStackDiagnosticsOf,
  qualityStackStatusOf,
  QUALITY_STACK_SCHEMA_VERSION,
  type QualityStackModules,
  type QualityStackResult,
} from "@/domain/quality-stack";
import { countDiagnosticsBySeverity } from "@/domain/quality-diagnostic";
import type { BeatValidationV2Result } from "@/domain/beat-validation-v2";
import type { QualityReviewV2Result } from "@/domain/quality-review-v2";
import type { CommercialReviewV2Result } from "@/domain/commercial-review-v2";

/** §21 输入：三套结论，缺哪一路就传 null——「这套没跑出来」与「这套跑出来了」由此分清。 */
export interface QualityStackInput {
  beatValidation: BeatValidationV2Result | null;
  qualityReview: QualityReviewV2Result | null;
  commercialReview: CommercialReviewV2Result | null;
}

export class QualityStackCoordinator {
  coordinate(input: QualityStackInput): QualityStackResult {
    const modules: QualityStackModules = {
      beatValidation: input.beatValidation ?? null,
      qualityReview: input.qualityReview ?? null,
      commercialReview: input.commercialReview ?? null,
    };
    const diagnostics = qualityStackDiagnosticsOf(modules);
    return {
      schemaVersion: QUALITY_STACK_SCHEMA_VERSION,
      status: qualityStackStatusOf(modules),
      ...(modules.beatValidation ? { beatValidation: modules.beatValidation } : {}),
      ...(modules.qualityReview ? { qualityReview: modules.qualityReview } : {}),
      ...(modules.commercialReview ? { commercialReview: modules.commercialReview } : {}),
      diagnostics,
      summary: countDiagnosticsBySeverity(diagnostics),
    };
  }
}
