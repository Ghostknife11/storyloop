/**
 * v1.6.0 Manifest 装配器：把一次 Run 里已经发生的事实收敛成 `RunManifest`。
 *
 * 它是**纯读**的：除了读产物算摘要，不写文件、不调模型、不做任何判断
 * （哪次 Attempt 入选、哪轮 Repair 修成了，都由 Pipeline 判定后传进来）。
 * 因此同一个输入永远得到同一份 Manifest，也因此在测试里可以拿临时目录完整跑一遍。
 *
 * 摘要在**文件落盘之后**现算（读回原文再哈希），所以 Manifest 里记的就是磁盘上那一份的摘要；
 * 文件不存在时对应产物条目不出现，`run-manifest.json` 自己也不进清单——它没办法记自己的摘要。
 *
 * 明确不做：不比较两次 Run、不统计失败原因、不给任何结论打分。这里只回答「是什么」。
 * v1.7.0 的 `experiment` 块同样由调用方传进来（实验出身是调用方才知道的事实），
 * 装配器不从产物里推断「这次 Run 是不是实验样本」。
 */

import type { ArtifactStore } from "@/storage/artifact-store";
import { attemptDirectoryName } from "@/core/generation-attempt";
import { repairDirectoryName } from "@/types/repair";
import type { RetryPolicy } from "@/core/retry-policy";
import { llmSettings } from "@/lib/app-config";
import { PROVIDERS } from "@/lib/constants";
import { PLAN_TEMPERATURE } from "@/lib/beat-planner";
import { STORY_TEMPERATURE } from "@/lib/story-generator";
import { REVIEW_TEMPERATURE } from "@/lib/basic-reviewer";
import { COMMERCIAL_REVIEW_TEMPERATURE } from "@/lib/commercial-reviewer";
import { BEAT_VALIDATION_TEMPERATURE } from "@/lib/beat-validator";
import { REPAIR_TEMPERATURE } from "@/lib/story-repairer";
import {
  RUN_MANIFEST_SCHEMA_VERSION,
  type ArtifactManifestEntry,
  type AttemptManifestEntry,
  type ExperimentProvenance,
  type ModelSnapshot,
  type ParameterSnapshot,
  type RepairManifestEntry,
  type RunManifest,
} from "@/types/run-manifest";
import { projectSnapshot } from "@/lib/tracking/project-snapshot";
import { promptSnapshots } from "@/lib/tracking/prompt-registry";
import { sha256Hex } from "@/lib/tracking/digest";

/**
 * v1.6.0 只有一个 `LLMClient`，六个阶段共用它（Pipeline 的 Writer / Reviewer / Repairer
 * 走同一个客户端，没有 Model Router），所以 `models` 映射只有一个键。
 * 等哪天真的按阶段接不同模型，这里加键就行，字段形状不用改。
 */
export const DEFAULT_MODEL_SLOT = "default";

/** 运行级文件名（v1.0.0 冻结的那批，v1.6.0 不新增运行级文件）。 */
const RUN_CONFIG_FILE = "config.json";
const RUN_BEAT_PLAN_FILE = "beats.json";
const RUN_BEAT_VALIDATION_FILE = "beat-validation.json";
const RUN_STORY_FILE = "story.md";
const RUN_VALIDATION_FILE = "validation.json";
const RUN_REVIEW_FILE = "review.json";
const RUN_COMMERCIAL_REVIEW_FILE = "commercial-review.json";
const RUN_QUALITY_FILE = "quality.json";

/** Attempt 级文件名。 */
const ATTEMPT_STORY_FILE = "story.md";
const ATTEMPT_VALIDATION_FILE = "validation.json";
const ATTEMPT_REVIEW_FILE = "review.json";
const ATTEMPT_COMMERCIAL_REVIEW_FILE = "commercial-review.json";
const ATTEMPT_QUALITY_FILE = "quality.json";
/** 修订开始前那份初始正文的副本（落盘规则见 docs/run-artifacts.md）。 */
const INITIAL_STORY_FILE = "initial_story.md";

/** Repair 级文件名。 */
const REPAIR_REQUEST_FILE = "request.json";
const REPAIR_STORY_FILE = "story.md";
const REPAIR_VALIDATION_FILE = "validation.json";
const REPAIR_REVIEW_FILE = "review.json";

/**
 * 请求里可覆盖的三项（`GenerateRuntime` 的形状）。
 * 刻意在这里声明一个结构类型而不是 import 服务层的接口：装配器不该依赖整个服务层。
 */
export interface ManifestRuntime {
  model?: string;
  baseUrl?: string;
  temperature?: number;
}

/** 一次 Attempt 的既有事实（由 Pipeline 判定后传入）。 */
export interface ManifestAttemptInput {
  attemptNumber: number;
  /** 满足 RetryPolicy 并入选。 */
  accepted: boolean;
  /** 未满足时的稳定原因；accepted 时是 null。 */
  retryReason: string | null;
  /** 这次 Attempt 里发生过的 Repair，按发生顺序。 */
  repairs: Array<{ repairNumber: number; issueType: string; success: boolean }>;
}

/** 装配一次 Manifest 需要的全部事实。 */
export interface RunManifestInput {
  runId: string;
  /** Run 起始时间，与 metadata 的 started_at 同一个值。 */
  startedAt: string;
  runtime?: ManifestRuntime;
  policy: RetryPolicy;
  attempts: ManifestAttemptInput[];
  /** 入选 Attempt 的编号；没有产生入选 Attempt（失败 / 全部耗尽）时是 null。 */
  selectedAttemptNumber: number | null;
  /**
   * v1.7.0：这次 Run 是某个受控实验的样本时带上它的出身（experimentId / variantId / repetition）。
   * 普通 Run 不传，Manifest 里 `experiment` 键不出现——与 v1.6.0 逐字一致。
   */
  experiment?: ExperimentProvenance;
}

function attemptRel(attemptNumber: number, file: string): string {
  return `attempts/${attemptDirectoryName(attemptNumber)}/${file}`;
}

function repairRel(attemptNumber: number, repairNumber: number, file: string): string {
  return `attempts/${attemptDirectoryName(attemptNumber)}/repairs/${repairDirectoryName(repairNumber)}/${file}`;
}

/**
 * 收集一个产物条目：文件不出现就整条不进清单（清单里不列不存在的路径）；
 * 读得到原文就附上 SHA-256，读不到（极小概率的并发删除）就只记路径。
 */
function collect(
  out: ArtifactManifestEntry[],
  store: ArtifactStore,
  runId: string,
  type: string,
  path: string,
  source?: { attemptId?: string; repairId?: string },
): void {
  if (!store.artifactExists(runId, path)) return;
  const entry: ArtifactManifestEntry = { type, path };
  if (source?.attemptId !== undefined) entry.sourceAttemptId = source.attemptId;
  if (source?.repairId !== undefined) entry.sourceRepairId = source.repairId;
  const text = store.readArtifactText(runId, path);
  if (text !== null) entry.sha256 = sha256Hex(text);
  out.push(entry);
}

/**
 * 从生效的 baseUrl 反推提供商名：命中 PROVIDERS 里某个默认地址的前缀就算。
 * 自定义中转站 / 未知地址时不猜——`provider` 键不出现，`model` 仍然如实记录。
 */
function providerOf(baseUrl: string): string | undefined {
  const normalized = baseUrl.replace(/\/+$/, "");
  for (const [key, info] of Object.entries(PROVIDERS)) {
    const prefix = info.defaultBaseURL.replace(/\/+$/, "");
    if (prefix !== "" && normalized.startsWith(prefix)) return key;
  }
  return undefined;
}

/** 模型快照：只记模型名、提供商与地址来源类别，绝不记 baseUrl 本体与任何凭据。 */
function modelSnapshotOf(runtime: ManifestRuntime | undefined): Record<string, ModelSnapshot> {
  const settings = llmSettings({ model: runtime?.model });
  const snapshot: ModelSnapshot = {
    model: settings.model,
    // 请求体带了 baseUrl 覆盖 = 这个地址过了 assertPublicBaseUrl 那道公网关卡；
    // 否则就是运维在 LLM_BASE_URL 里配的受信地址。两者都只记类别，不记地址。
    baseUrlClass: runtime?.baseUrl?.trim() ? "request-public-override" : "server-configured",
  };
  const provider = providerOf(settings.baseUrl);
  if (provider !== undefined) snapshot.provider = provider;
  return { [DEFAULT_MODEL_SLOT]: snapshot };
}

/** 五个阶段各自的温度：规划 / 生成跟着请求覆盖走，其余四个是写死的固定值。 */
function parameterSnapshotOf(runtime: ManifestRuntime | undefined, policy: RetryPolicy): ParameterSnapshot {
  const override = runtime?.temperature;
  return {
    generation: { temperature: override ?? STORY_TEMPERATURE },
    planning: { temperature: override ?? PLAN_TEMPERATURE },
    review: { temperature: REVIEW_TEMPERATURE },
    commercialReview: { temperature: COMMERCIAL_REVIEW_TEMPERATURE },
    beatValidation: { temperature: BEAT_VALIDATION_TEMPERATURE },
    repair: { temperature: REPAIR_TEMPERATURE },
    retry: {
      maxAttempts: policy.max_attempts,
      minReviewScore: policy.min_review_score,
      retryOnValidationFailure: policy.retry_on_validation_failure,
      enableRepair: policy.enable_repair,
      maxRepairsPerAttempt: policy.max_repairs_per_attempt,
    },
  };
}

/** 一次 Attempt 的 Manifest 条目。 */
function attemptEntryOf(input: ManifestAttemptInput): AttemptManifestEntry {
  return {
    attemptId: attemptDirectoryName(input.attemptNumber),
    index: input.attemptNumber,
    status: input.accepted ? "accepted" : "not_accepted",
    retryReason: input.retryReason,
    repairIds: input.repairs.map((r) => repairDirectoryName(r.repairNumber)),
  };
}

/** 一次 Attempt 内第 i 轮 Repair（i 从 0 起）的 Manifest 条目：吃进哪份正文、吐出哪份正文。 */
function repairEntryOf(attemptNumber: number, repairs: ManifestAttemptInput["repairs"], i: number): RepairManifestEntry {
  const repair = repairs[i];
  const previous = i > 0 ? repairs[i - 1] : null;
  return {
    repairId: repairDirectoryName(repair.repairNumber),
    attemptId: attemptDirectoryName(attemptNumber),
    index: i + 1,
    category: repair.issueType,
    succeeded: repair.success,
    // 第一轮修订吃进 initial_story.md（修订前的原文），之后每一轮吃进上一轮吐出的那一版
    inputStoryArtifact: previous === null
      ? attemptRel(attemptNumber, INITIAL_STORY_FILE)
      : repairRel(attemptNumber, previous.repairNumber, REPAIR_STORY_FILE),
    outputStoryArtifact: repairRel(attemptNumber, repair.repairNumber, REPAIR_STORY_FILE),
  };
}

/** 装配完整 Manifest。 */
export function buildRunManifest(
  input: RunManifestInput,
  store: ArtifactStore,
  now: () => Date = () => new Date(),
): RunManifest {
  const attemptIds = new Map(input.attempts.map((a) => [a.attemptNumber, attemptDirectoryName(a.attemptNumber)]));
  const artifacts: ArtifactManifestEntry[] = [];
  const repairs: RepairManifestEntry[] = [];

  // beats.json / beat-validation.json 有没有真的落盘，直接看磁盘，不入参：
  // 调用方没必要（也不该）替磁盘回答这件事。
  const beatPlanWritten = store.artifactExists(input.runId, RUN_BEAT_PLAN_FILE);

  // 运行级那份：promote 之后与入选 Attempt 严格同版
  collect(artifacts, store, input.runId, "config", RUN_CONFIG_FILE);
  if (beatPlanWritten) collect(artifacts, store, input.runId, "beatPlan", RUN_BEAT_PLAN_FILE);
  collect(artifacts, store, input.runId, "beatValidation", RUN_BEAT_VALIDATION_FILE);
  collect(artifacts, store, input.runId, "story", RUN_STORY_FILE);
  collect(artifacts, store, input.runId, "validation", RUN_VALIDATION_FILE);
  collect(artifacts, store, input.runId, "review", RUN_REVIEW_FILE);
  collect(artifacts, store, input.runId, "commercialReview", RUN_COMMERCIAL_REVIEW_FILE);
  collect(artifacts, store, input.runId, "quality", RUN_QUALITY_FILE);

  const attempts: AttemptManifestEntry[] = input.attempts.map((attempt) => {
    const entry = attemptEntryOf(attempt);
    const attemptId = attemptIds.get(attempt.attemptNumber);
    const dir = attemptRel(attempt.attemptNumber, "");
    const here = { attemptId };
    const ATTEMPT_STORY = `${dir}${ATTEMPT_STORY_FILE}`;
    const ATTEMPT_VALIDATION = `${dir}${ATTEMPT_VALIDATION_FILE}`;
    const ATTEMPT_REVIEW = `${dir}${ATTEMPT_REVIEW_FILE}`;
    const ATTEMPT_COMMERCIAL_REVIEW = `${dir}${ATTEMPT_COMMERCIAL_REVIEW_FILE}`;
    const ATTEMPT_QUALITY = `${dir}${ATTEMPT_QUALITY_FILE}`;
    const repairPaths = (repairNumber: number) => {
      const rdir = `${dir}repairs/${repairDirectoryName(repairNumber)}/`;
      return {
        request: `${rdir}${REPAIR_REQUEST_FILE}`,
        story: `${rdir}${REPAIR_STORY_FILE}`,
        validation: `${rdir}${REPAIR_VALIDATION_FILE}`,
        review: `${rdir}${REPAIR_REVIEW_FILE}`,
      };
    };
    collect(artifacts, store, input.runId, "story", ATTEMPT_STORY, here);
    if (store.artifactExists(input.runId, ATTEMPT_VALIDATION)) {
      entry.validationArtifact = ATTEMPT_VALIDATION;
      collect(artifacts, store, input.runId, "validation", ATTEMPT_VALIDATION, here);
    }
    if (store.artifactExists(input.runId, ATTEMPT_REVIEW)) {
      entry.reviewArtifact = ATTEMPT_REVIEW;
      collect(artifacts, store, input.runId, "review", ATTEMPT_REVIEW, here);
    }
    if (store.artifactExists(input.runId, ATTEMPT_COMMERCIAL_REVIEW)) {
      entry.commercialReviewArtifact = ATTEMPT_COMMERCIAL_REVIEW;
      collect(artifacts, store, input.runId, "commercialReview", ATTEMPT_COMMERCIAL_REVIEW, here);
    }
    if (store.artifactExists(input.runId, ATTEMPT_QUALITY)) {
      entry.qualityArtifact = ATTEMPT_QUALITY;
      collect(artifacts, store, input.runId, "quality", ATTEMPT_QUALITY, here);
    }
    attempt.repairs.forEach((_, i) => {
      repairs.push(repairEntryOf(attempt.attemptNumber, attempt.repairs, i));
      const repairNumber = attempt.repairs[i].repairNumber;
      const scope = { attemptId, repairId: repairDirectoryName(repairNumber) };
      const paths = repairPaths(repairNumber);
      collect(artifacts, store, input.runId, "repairRequest", paths.request, scope);
      collect(artifacts, store, input.runId, "repairStory", paths.story, scope);
      collect(artifacts, store, input.runId, "repairValidation", paths.validation, scope);
      collect(artifacts, store, input.runId, "repairReview", paths.review, scope);
    });
    return entry;
  });

  const selected = input.selectedAttemptNumber === null
    ? undefined
    : input.attempts.find((a) => a.attemptNumber === input.selectedAttemptNumber);
  // 入选 Attempt 最终留下的那一版正文 = 它里面最后一次真正修成的 Repair；
  // 一次都没修成时没有 selectedRepairId——那时最终正文就是初始生成的那一版。
  const selectedRepairId = selected
    ? [...selected.repairs].reverse().find((r) => r.success)?.repairNumber
    : undefined;

  return {
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runId: input.runId,
    project: projectSnapshot(),
    models: modelSnapshotOf(input.runtime),
    prompts: promptSnapshots(),
    parameters: parameterSnapshotOf(input.runtime, input.policy),
    storyConfigRef: RUN_CONFIG_FILE,
    ...(beatPlanWritten ? { beatPlanRef: RUN_BEAT_PLAN_FILE } : {}),
    attempts,
    ...(input.selectedAttemptNumber !== null
      ? { selectedAttemptId: attemptDirectoryName(input.selectedAttemptNumber) }
      : {}),
    repairs,
    ...(selectedRepairId !== undefined && selected !== undefined
      ? { selectedRepairId: repairDirectoryName(selectedRepairId) }
      : {}),
    artifacts,
    startedAt: input.startedAt,
    completedAt: now().toISOString(),
    ...(input.experiment !== undefined ? { experiment: input.experiment } : {}),
  };
}
