import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import { reviewResultOf, type ReviewResult } from "@/types/review-result";
import { validationResultOf, type ValidationResult } from "@/types/validation-result";
import { qualityResultOf, type QualityResult } from "@/types/quality";
import { beatValidationResultOf, type BeatValidationResult } from "@/types/beat-validation";
import {
  commercialReviewResultOf,
  type CommercialReviewResult,
} from "@/types/commercial-review";
import { attemptDirectoryName } from "@/core/generation-attempt";
import {
  repairDirectoryName,
  type RepairMetadata,
  type RepairRequestRecord,
} from "@/types/repair";
import type { RunManifest } from "@/types/run-manifest";
import { runManifestOf } from "@/types/run-manifest";
import type { RunTelemetry } from "@/types/telemetry";
import { runTelemetryOf, validateRunTelemetry } from "@/types/telemetry";
import type { FailureAnalysisResult } from "@/types/failure-analysis";
import { failureAnalysisOf, validateFailureAnalysis } from "@/types/failure-analysis";

/**
 * §13/§22 ArtifactStore：只负责创建目录、保存 JSON / Markdown / Metadata、返回路径。
 * 不得调用 LLM、分析内容、决定 Pipeline 流程。§22 File System Only。
 * v0.7.0 新增 Attempt 级产物（§23）与 promote（§28）：不改变既有方法的语义。
 * v0.8.0 新增 Repair 级产物（§29-§32）与 initial_story.md（§30）：同样是纯追加。
 * v1.2.0 新增 quality.json（§20/§21）并把它加入 promote 清单（§57）：同样是纯追加，
 * 只是多一个由 QualityAssembler 装配出来的统一质量快照。
 * v1.5.0 新增 commercial-review.json（TASK §16/§17）：商业可读性结论同样进 promote 清单，
 * 于是运行根那一份永远与入选正文一一对应。
 */

/** §23/§60 attempt 根目录名；§28 Windows 不可靠目录层级命名，这里固定 ASCII。 */
const ATTEMPTS_DIR = "attempts";

/** §29 repairs 子目录：挂在 attempt 目录内——Repair 不新增 attempt（§17）。 */
const REPAIRS_DIR = "repairs";

/** §30 首次修订前的初始正文：只有真的发生过修订才写，没修订的 Attempt 不需要它。 */
const INITIAL_STORY = "initial_story.md";

/** v1.6.0 运行清单：与 metadata.json 并排放在 Run 根目录，两者互不替代。 */
const RUN_MANIFEST_FILE = "run-manifest.json";

/** v1.8.0 运行级遥测：执行过程（阶段耗时 / 调用 / usage），与上面两份互不替代。 */
const TELEMETRY_FILE = "telemetry.json";

/** v1.9.0 运行级失败分析：对上面这些事实做的确定性分类，自己不产生新事实。 */
const FAILURE_ANALYSIS_FILE = "failure-analysis.json";

/**
 * §19 产物写入失败：磁盘满 / 权限不足 / 目录被占用都归这一类。
 * 消息只带 Run 内的相对文件名，不带服务器绝对路径（§67）。
 *
 * v0.9.1：cause 不再整条拼进消息。node:fs 的异常文本形如
 *   EISDIR: illegal operation on a directory, open 'C:\\...\\runs\\<id>\\story.md'
 * 路径就在后半截，原样传出去一路会走到 API 响应体里。
 * 只取 code / syscall（EACCES open、ENOSPC write）——两者都不含路径，也够定位是哪种失败；
 * 取不到就给固定文案，绝不回退到 cause.message。
 */
export class ArtifactWriteError extends Error {
  constructor(
    readonly filename: string,
    cause: unknown,
  ) {
    super(`产物写入失败：${filename}（${failureCodeOf(cause)}）`);
    this.name = "ArtifactWriteError";
  }
}

/** 从 node:fs 异常里取不带路径的失败码；没有就用固定文案。 */
function failureCodeOf(cause: unknown): string {
  const detail = (cause ?? {}) as { code?: unknown; syscall?: unknown };
  const parts: string[] = [];
  if (typeof detail.code === "string" && detail.code.trim()) parts.push(detail.code.trim());
  if (typeof detail.syscall === "string" && detail.syscall.trim()) parts.push(detail.syscall.trim());
  return parts.length > 0 ? parts.join(" ") : "未知原因";
}

export class ArtifactStore {
  private runsRoot: string;

  /** runsRoot：Run 目录的根。缺省为 <cwd>/runs（§15）。 */
  constructor(runsRoot?: string) {
    this.runsRoot = resolve(runsRoot || join(process.cwd(), "runs"));
  }

  /** §50 Path Traversal 防护：run_id 由系统生成，但仍做 containment check。 */
  private runDir(runId: string): string {
    const dir = resolve(this.runsRoot, runId);
    if (dir !== this.runsRoot && !dir.startsWith(this.runsRoot + sep)) {
      throw new Error("Run 目录越界");
    }
    return dir;
  }

  /** 测试与调试用：Run 目录的绝对路径（API 响应不得返回它，§67）。 */
  resolveRunDir(runId: string): string {
    return this.runDir(runId);
  }

  createRunDirectory(runId: string): string {
    const dir = this.runDir(runId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new ArtifactWriteError(runId, e);
    }
    return dir;
  }

  putConfig(runId: string, config: StoryConfig): string {
    return this.putJson(runId, "config.json", config);
  }

  putBeatPlan(runId: string, plan: BeatPlan): string {
    return this.putJson(runId, "beats.json", plan);
  }

  putStory(runId: string, title: string, story: string): string {
    return this.putText(runId, "story.md", `# ${title}\n\n${story}\n`);
  }

  /** §21/§22 Review 产物：与其它产物同一套原子写入，重复审阅时覆盖（§30）。 */
  putReview(runId: string, review: ReviewResult): string {
    return this.putJson(runId, "review.json", review);
  }

  /** §21/§22 Validation 产物：同一套原子写入；§27 手动 Revalidate 时覆盖，不建历史。 */
  putValidation(runId: string, validation: ValidationResult): string {
    return this.putJson(runId, "validation.json", validation);
  }

  /** v1.2.0 §20 运行级质量快照：由 QualityAssembler 装配，覆盖写（同一次 Run 只保留最终结论）。 */
  putQuality(runId: string, quality: QualityResult): string {
    return this.putJson(runId, "quality.json", quality);
  }

  /** v1.4.0 §20 BeatPlan 结构校验结论：运行级产物，对 config / beats 唯一，不随 Attempt 变化。 */
  putBeatValidation(runId: string, beatValidation: BeatValidationResult): string {
    return this.putJson(runId, "beat-validation.json", beatValidation);
  }

  /**
   * v1.5.0 TASK §16 运行级商业可读性结论：与 quality.json 同一套覆盖写语义。
   * 实际写入走 promoteAttempt 从入选 Attempt 复制过来（与 story.md 同一机制），
   * 这里保留同形方法供手动审阅入口直接覆盖运行根那一份。
   */
  putCommercialReview(runId: string, commercialReview: CommercialReviewResult): string {
    return this.putJson(runId, "commercial-review.json", commercialReview);
  }

  putMetadata(runId: string, metadata: Record<string, unknown>): string {
    return this.putJson(runId, "metadata.json", metadata);
  }

  /**
   * v1.9.0 运行级失败分析：与 metadata.json / run-manifest.json / telemetry.json
   * 并排放在 Run 根目录。它是**对已有事实做的分类**，自己不是新的事实来源。
   *
   * 落盘前过一遍 validateFailureAnalysis（与 putTelemetry 同一套口径）：
   * 形状不对就在写盘那一刻抛 ArtifactWriteError，不留给以后的读者去猜。
   */
  putFailureAnalysis(runId: string, analysis: FailureAnalysisResult): string {
    const checked = validateFailureAnalysis(analysis);
    return this.putJson(runId, FAILURE_ANALYSIS_FILE, checked);
  }

  /** v1.9.0 读回失败分析：文件缺失 / JSON 坏 / 形状不对都归一成 null（§35 旧 Run）。 */
  readFailureAnalysis(runId: string): FailureAnalysisResult | null {
    const raw = this.readJson(runId, FAILURE_ANALYSIS_FILE);
    if (raw === null) return null;
    return failureAnalysisOf(raw);
  }

  /**
   * v1.8.0 运行级遥测：与 metadata.json / run-manifest.json 并排放在 Run 根目录。
   *
   * 落盘前过一遍 validateRunTelemetry：采集器是本仓库自己的代码，但「观测数据本身
   * 长得不对」应该在写盘那一刻就炸出来，而不是留给以后的读者去猜。校验不过就抛
   * ArtifactWriteError，与其它产物同一套失败口径。
   */
  putTelemetry(runId: string, telemetry: RunTelemetry): string {
    const checked = validateRunTelemetry(telemetry);
    return this.putJson(runId, TELEMETRY_FILE, checked);
  }

  /**
   * v1.6.0 运行清单：与 metadata.json 并排落盘，内容经过 validateRunManifest 校验。
   *
   * 这里不接拒收语义：调用方在写之前已经自己校验过（Pipeline 落盘前后各校验一次），
   * 出错时抛 ArtifactWriteError，由 Pipeline 的 catch 收尾成一次显式失败。
   */
  putManifest(runId: string, manifest: RunManifest): string {
    return this.putJson(runId, RUN_MANIFEST_FILE, manifest);
  }

  runExists(runId: string): boolean {
    return existsSync(this.runDir(runId));
  }

  // ---------------------------------------------------------------------------
  // §23 Attempt 级产物
  // ---------------------------------------------------------------------------

  /** §60 createAttemptDirectory：runs/<run_id>/attempts/NN（NN = 01 起，§6）。 */
  createAttemptDirectory(runId: string, attemptNumber: number): string {
    return this.attemptDir(runId, attemptNumber);
  }

  /** 只判断存在性：不顺手创建目录，否则「不存在的 attempt」永远查不到。 */
  attemptExists(runId: string, attemptNumber: number): boolean {
    return existsSync(this.attemptDirPath(runId, attemptNumber));
  }

  putAttemptStory(runId: string, attemptNumber: number, title: string, story: string): string {
    return this.putText(runId, this.attemptFile(attemptNumber, "story.md"), `# ${title}\n\n${story}\n`);
  }

  putAttemptValidation(runId: string, attemptNumber: number, validation: ValidationResult): string {
    return this.putJson(runId, this.attemptFile(attemptNumber, "validation.json"), validation);
  }

  putAttemptReview(runId: string, attemptNumber: number, review: ReviewResult): string {
    return this.putJson(runId, this.attemptFile(attemptNumber, "review.json"), review);
  }

  /**
   * v1.2.0 §21 Attempt 级质量快照。口径与 attempt metadata 一致：取这次 Attempt 的
   * **最终**结论（发生过修订时就是修订后那一轮），首次结论仍看 validation.json / review.json。
   */
  putAttemptQuality(runId: string, attemptNumber: number, quality: QualityResult): string {
    return this.putJson(runId, this.attemptFile(attemptNumber, "quality.json"), quality);
  }

  /**
   * v1.5.0 TASK §17 Attempt 级商业可读性结论。与同目录 story.md 严格对应：
   * 这次尝试发生过修订时写的是修订后那一版的结论（调用方保证），
   * 因此它描述的就是 attempts/NN/story.md 这份正文。
   */
  putAttemptCommercialReview(
    runId: string,
    attemptNumber: number,
    commercialReview: CommercialReviewResult,
  ): string {
    return this.putJson(runId, this.attemptFile(attemptNumber, "commercial-review.json"), commercialReview);
  }

  /** §24 Attempt metadata：编号 / 是否被接受 / 重试原因 / 分数 / 校验结论。 */
  putAttemptMetadata(runId: string, attemptNumber: number, metadata: Record<string, unknown>): string {
    return this.putJson(runId, this.attemptFile(attemptNumber, "metadata.json"), metadata);
  }

  // ---------------------------------------------------------------------------
  // §29-§32 Repair 级产物：runs/<run_id>/attempts/NN/repairs/NN/
  // ---------------------------------------------------------------------------

  /**
   * §30 initial_story.md：第一次修订之前保存初始正文。
   * §30 attempt 根目录的 story.md 始终是该 Attempt 的最终版本，所以初始版本必须另有其名。
   */
  putAttemptInitialStory(runId: string, attemptNumber: number, title: string, story: string): string {
    return this.putText(runId, this.attemptFile(attemptNumber, INITIAL_STORY), `# ${title}\n\n${story}\n`);
  }

  /** §31 repair request.json：编号 + 类型 + 问题说明，正好三个字段。 */
  putRepairRequest(runId: string, attemptNumber: number, request: RepairRequestRecord): string {
    return this.putJson(runId, this.repairFile(attemptNumber, request.repair_number, "request.json"), request);
  }

  /** §30 修订后正文：attempt 的 story.md 由调用方更新为同一份内容。 */
  putRepairStory(runId: string, attemptNumber: number, repairNumber: number, title: string, story: string): string {
    return this.putText(runId, this.repairFile(attemptNumber, repairNumber, "story.md"), `# ${title}\n\n${story}\n`);
  }

  /** §15：Repair 后必须重新 Validate——结论单独落一份，不覆盖 attempt 的 validation.json。 */
  putRepairValidation(runId: string, attemptNumber: number, repairNumber: number, validation: ValidationResult): string {
    return this.putJson(runId, this.repairFile(attemptNumber, repairNumber, "validation.json"), validation);
  }

  /** §16：Repair 后必须重新 Review——同理，不覆盖 attempt 的 review.json。 */
  putRepairReview(runId: string, attemptNumber: number, repairNumber: number, review: ReviewResult): string {
    return this.putJson(runId, this.repairFile(attemptNumber, repairNumber, "review.json"), review);
  }

  /** §32 Repair metadata：只记录这次修订前后的对比，不做历史 Repair Analytics。 */
  putRepairMetadata(runId: string, attemptNumber: number, repairNumber: number, metadata: RepairMetadata): string {
    return this.putJson(runId, this.repairFile(attemptNumber, repairNumber, "metadata.json"), metadata);
  }

  /**
   * v1.2.1 修订级结论的读回：装配旧 Run 的质量快照时要取「这次尝试最终留下的那一版」，
   * 也就是最后一次真正跑过校验 / 审阅的修订目录。修订失败时这两个文件不存在，读回 null。
   */
  readRepairValidation(runId: string, attemptNumber: number, repairNumber: number): ValidationResult | null {
    return validationResultOf(this.readJson(runId, this.repairFile(attemptNumber, repairNumber, "validation.json")));
  }

  /** v1.2.1：同 readRepairValidation，取修订后重新审阅的那一份结论。 */
  readRepairReview(runId: string, attemptNumber: number, repairNumber: number): ReviewResult | null {
    return reviewResultOf(this.readJson(runId, this.repairFile(attemptNumber, repairNumber, "review.json")));
  }

  // ---------------------------------------------------------------------------
  // §28 只读访问：GET /api/runs/{run_id} 与 attempt 详情（§39）只读取内容，
  // 不把服务器绝对路径带进响应（§67）。
  // ---------------------------------------------------------------------------

  /** 已存在的 attempt 编号，升序；只有目录名形如两位数字的才算（§6）。 */
  listAttemptNumbers(runId: string): number[] {
    const dir = join(this.runDir(runId), ATTEMPTS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))
      .map((e) => Number(e.name))
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
  }

  /** §40 某个 Attempt 下已存在的 repair 编号，升序；目录规则与 attempt 一致。 */
  listRepairNumbers(runId: string, attemptNumber: number): number[] {
    const dir = join(this.runDir(runId), ATTEMPTS_DIR, attemptDirectoryName(attemptNumber), REPAIRS_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{2}$/.test(e.name))
      .map((e) => Number(e.name))
      .filter((n) => Number.isInteger(n) && n >= 1)
      .sort((a, b) => a - b);
  }

  readRunMetadata(runId: string): Record<string, unknown> | null {
    return this.readJson(runId, "metadata.json");
  }

  /**
   * v1.6.0 运行清单的读回。
   * v1.6.0 之前生成的 Run 没有这个文件，返回 null——读接口照常给出那一版的其它内容。
   */
  readRunManifest(runId: string): RunManifest | null {
    const raw = this.readJson(runId, RUN_MANIFEST_FILE);
    if (raw === null) return null;
    return runManifestOf(raw);
  }

  /**
   * v1.8.0 遥测的读回。
   * v1.8.0 之前生成的 Run 没有这个文件，返回 null——读接口照常给出那一版的其它内容，
   * 由 UI 决定怎么展示「这一次运行没有遥测」。形状不对（被手改过）同样归一成 null。
   */
  readRunTelemetry(runId: string): RunTelemetry | null {
    const raw = this.readJson(runId, TELEMETRY_FILE);
    if (raw === null) return null;
    return runTelemetryOf(raw);
  }

  /**
   * v1.6.0 装配 Manifest 时判断某个产物文件是否真的在磁盘上。
   * 只接受 Run 内相对路径（attempts/…、beats.json 之类）；越界路径按「不存在」处理，
   * 不让拼接路径决定了能不能穿越目录这件事。
   */
  artifactExists(runId: string, artifactPath: string): boolean {
    try {
      return existsSync(this.resolveInRun(this.runDir(runId), artifactPath));
    } catch {
      return false;
    }
  }

  /** v1.6.0 读回产物原文算 SHA-256；文件不在或读不动时给 null。 */
  readArtifactText(runId: string, artifactPath: string): string | null {
    try {
      return this.readText(runId, artifactPath);
    } catch {
      return null;
    }
  }

  readAttemptMetadata(runId: string, attemptNumber: number): Record<string, unknown> | null {
    return this.readJson(runId, this.attemptFile(attemptNumber, "metadata.json"));
  }

  /** §23 Attempt 级产物的读回：repairs 一并读出来，GET 才能给出修复摘要（§40）。 */
  readAttemptStory(runId: string, attemptNumber: number): string | null {
    return this.readText(runId, this.attemptFile(attemptNumber, "story.md"));
  }

  readAttemptInitialStory(runId: string, attemptNumber: number): string | null {
    return this.readText(runId, this.attemptFile(attemptNumber, INITIAL_STORY));
  }

  /** §23 Attempt 级产物的读回：repairs 一并读出来，GET 才能给出修复摘要（§40）。
   *  v1.4.1：磁盘上的结论按 schema 归一化后再返回——文件被手改坏时给 null，
   *  不让坏数据一路带到响应体里，更不让读接口 500（compatibility §16）。 */
  readAttemptValidation(runId: string, attemptNumber: number): ValidationResult | null {
    return validationResultOf(this.readJson(runId, this.attemptFile(attemptNumber, "validation.json")));
  }

  readAttemptReview(runId: string, attemptNumber: number): ReviewResult | null {
    return reviewResultOf(this.readJson(runId, this.attemptFile(attemptNumber, "review.json")));
  }

  readFinalStory(runId: string): string | null {
    return this.readText(runId, "story.md");
  }

  readFinalValidation(runId: string): ValidationResult | null {
    return validationResultOf(this.readJson(runId, "validation.json"));
  }

  readFinalReview(runId: string): ReviewResult | null {
    return reviewResultOf(this.readJson(runId, "review.json"));
  }

  /** v1.2.0 §26：v1.2.0 之前的 Run 没有这个文件，读到 null 由调用方临时装配。 */
  readFinalQuality(runId: string): QualityResult | null {
    return qualityResultOf(this.readJson(runId, "quality.json"));
  }

  /** v1.4.0 §26：v1.4.0 之前的 Run 没有这个文件，读到 null 由界面整段隐藏。 */
  readFinalBeatValidation(runId: string): BeatValidationResult | null {
    return beatValidationResultOf(this.readJson(runId, "beat-validation.json"));
  }

  /** v1.5.0 TASK §32：v1.5.0 之前的 Run 没有这个文件，读到 null 由界面整段隐藏。 */
  readFinalCommercialReview(runId: string): CommercialReviewResult | null {
    return commercialReviewResultOf(this.readJson(runId, "commercial-review.json"));
  }

  readAttemptQuality(runId: string, attemptNumber: number): QualityResult | null {
    return qualityResultOf(this.readJson(runId, this.attemptFile(attemptNumber, "quality.json")));
  }

  /** v1.5.0 TASK §17：某一次尝试的商业可读性结论；没有这个文件（旧 Run / 没跑这一步）时为 null。 */
  readAttemptCommercialReview(
    runId: string,
    attemptNumber: number,
  ): CommercialReviewResult | null {
    return commercialReviewResultOf(
      this.readJson(runId, this.attemptFile(attemptNumber, "commercial-review.json")),
    );
  }

  // ---------------------------------------------------------------------------
  // §28 promoteAttemptToFinal：Windows 没有可靠符号链接，用复制/重写落地。
  // ---------------------------------------------------------------------------

  promoteAttempt(runId: string, attemptNumber: number): Record<string, string> {
    const promoted: Record<string, string> = {};
    const dir = this.attemptDirPath(runId, attemptNumber);
    // §67：绝对路径不进异常消息，调用方本来就知道 runs 根在哪
    if (!existsSync(dir)) throw new Error(`Attempt ${attemptNumber} 不存在`);

    for (const filename of [
      "story.md",
      "validation.json",
      "review.json",
      "quality.json",
      // v1.5.0 TASK §16/§39：商业结论跟着入选正文一起晋升，
      // 于是运行根那一份永远描述 selected attempt 的 story.md（没有这个文件时就跳过）。
      "commercial-review.json",
    ]) {
      const source = join(dir, filename);
      if (!existsSync(source)) continue;
      const target = this.rootFile(runId, filename);
      // §21/promote 与其它写盘同一套原子语义：先写同目录临时文件再 rename，
      // 进程中断时Run 根目录不会留下复制了一半的 story.md / review.json
      const tmpPath = this.tmpPathFor(target);
      try {
        copyFileSync(source, tmpPath);
        renameSync(tmpPath, target);
      } catch (e) {
        throw new ArtifactWriteError(filename, e);
      }
      promoted[filename] = target;
    }
    return promoted;
  }

  // ---------------------------------------------------------------------------
  // 内部：路径解析与原子写入
  // ---------------------------------------------------------------------------

  /** 解析（不创建）attempt 目录路径。 */
  private attemptDirPath(runId: string, attemptNumber: number): string {
    const n = attemptDirectoryName(attemptNumber);
    return resolve(this.runDir(runId), ATTEMPTS_DIR, n);
  }

  private attemptDir(runId: string, attemptNumber: number): string {
    const dir = this.attemptDirPath(runId, attemptNumber);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private attemptFile(attemptNumber: number, filename: string): string {
    return `${ATTEMPTS_DIR}/${attemptDirectoryName(attemptNumber)}/${filename}`;
  }

  /** attempts/NN/repairs/NN/filename（§29）。 */
  private repairFile(attemptNumber: number, repairNumber: number, filename: string): string {
    return `${ATTEMPTS_DIR}/${attemptDirectoryName(attemptNumber)}/${REPAIRS_DIR}/${repairDirectoryName(repairNumber)}/${filename}`;
  }

  /** 解析（不创建）repair 目录路径。 */
  private repairDirPath(runId: string, attemptNumber: number, repairNumber: number): string {
    const n = repairDirectoryName(repairNumber);
    return resolve(this.runDir(runId), ATTEMPTS_DIR, attemptDirectoryName(attemptNumber), REPAIRS_DIR, n);
  }

  private rootFile(runId: string, filename: string): string {
    return join(this.runDir(runId), filename);
  }

  private putJson(runId: string, filename: string, data: unknown): string {
    return this.putText(runId, filename, JSON.stringify(data, null, 2));
  }

  /** §21 原子写入：临时文件 → rename，避免进程中断留下半个 JSON / Markdown。 */
  private putText(runId: string, filename: string, content: string): string {
    const dir = this.runDir(runId);
    const finalPath = this.resolveInRun(dir, filename);
    const tmpPath = this.tmpPathFor(finalPath);
    try {
      // §23：attempts/NN 由首次写入惰性创建
      mkdirSync(join(finalPath, ".."), { recursive: true });
      writeFileSync(tmpPath, content, "utf8");
      renameSync(tmpPath, finalPath);
    } catch (e) {
      throw new ArtifactWriteError(filename, e);
    }
    return finalPath;
  }

  /** 临时文件与目标同目录同前缀，只多一个前导点：中断时残留的 `.story.md.tmp`
   *  落在它自己该在的那一层，不会挤到 Run 根目录里冒充产物。 */
  private tmpPathFor(finalPath: string): string {
    return join(join(finalPath, ".."), `.${basename(finalPath)}.tmp`);
  }

  private readJson(runId: string, filename: string): Record<string, unknown> | null {
    const raw = this.readText(runId, filename);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private readText(runId: string, filename: string): string | null {
    const dir = this.runDir(runId);
    const path = this.resolveInRun(dir, filename);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  /** 路径拼接后必须仍落在该 Run 目录内（§50）。 */
  private resolveInRun(dir: string, filename: string): string {
    const path = resolve(dir, filename);
    if (path !== dir && !path.startsWith(dir + sep)) {
      throw new Error("Run 目录越界");
    }
    return path;
  }
}
