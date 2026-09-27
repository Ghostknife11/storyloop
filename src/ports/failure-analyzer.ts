/**
 * v2.0.0 Ports：失败分析端口（§29/§43）。
 *
 * Engine 的 GenerationPipeline 在每次 Run 收尾时把「这一次的证据」交给分析器，
 * 但它不自己读盘、不自己归类——FailureAnalyzer 属于 Analysis（§29），
 * 依赖的是结构化 evidence，而不是自己到 filesystem 里随意翻文件。
 *
 * 这条边是 v2.0.0 拆掉一个环的关键：v1.x 里 pipeline.ts 直接 import
 * `@/lib/failure-analysis-service`，于是 Engine → Analysis、Analysis（实验执行器）
 * → Application → Engine 三条边首尾相接成一个环（§72）。现在 Engine 只看见这个端口，
 * 实现（读盘 + 归类）由 Application 在组装时注入。
 */

import type { FailureAnalysisResult } from "@/domain/failure-analysis";

/** §30 metadata 的两个 additive 摘要字段。 */
export interface FailureAnalysisMetadataPatch {
  failure_analysis_status: string;
  primary_failure_category?: string;
}

export interface FailureAnalyzer {
  /** 对盘上这一次 Run 的产物做确定性分类；分析自己出错时返回 null（不猜类别）。 */
  analyzeRun(runId: string, extraCodes?: readonly string[]): FailureAnalysisResult | null;
  /** 异常链上的真实错误码（§40）：交给分析器当补充证据。 */
  codesOf(error: unknown): string[];
  /** §30 只产生两个摘要字段；没分析出来就给 unavailable。 */
  metadataPatchOf(analysis: FailureAnalysisResult | null): FailureAnalysisMetadataPatch;
}

/** 未注入分析器时的缺省行为：不分析、不写盘，metadata 如实记 unavailable */
export const NO_FAILURE_ANALYZER: FailureAnalyzer = {
  analyzeRun: () => null,
  codesOf: () => [],
  metadataPatchOf: () => ({ failure_analysis_status: "unavailable" }),
};
