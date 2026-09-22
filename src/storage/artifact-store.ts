import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import { attemptDirectoryName } from "@/core/generation-attempt";
import {
  repairDirectoryName,
  type RepairMetadata,
  type RepairRequestRecord,
} from "@/types/repair";

/**
 * §13/§22 ArtifactStore：只负责创建目录、保存 JSON / Markdown / Metadata、返回路径。
 * 不得调用 LLM、分析内容、决定 Pipeline 流程。§22 File System Only。
 * v0.7.0 新增 Attempt 级产物（§23）与 promote（§28）：不改变既有方法的语义。
 * v0.8.0 新增 Repair 级产物（§29-§32）与 initial_story.md（§30）：同样是纯追加。
 */

/** §23/§60 attempt 根目录名；§28 Windows 不可靠目录层级命名，这里固定 ASCII。 */
const ATTEMPTS_DIR = "attempts";

/** §29 repairs 子目录：挂在 attempt 目录内——Repair 不新增 attempt（§17）。 */
const REPAIRS_DIR = "repairs";

/** §30 首次修订前的初始正文：只有真的发生过修订才写，没修订的 Attempt 不需要它。 */
const INITIAL_STORY = "initial_story.md";

/**
 * §19 产物写入失败：磁盘满 / 权限不足 / 目录被占用都归这一类。
 * 消息只带 Run 内的相对文件名，不带服务器绝对路径（§67）。
 */
export class ArtifactWriteError extends Error {
  constructor(
    readonly filename: string,
    cause: unknown,
  ) {
    super(`产物写入失败：${filename}（${cause instanceof Error ? cause.message : String(cause)}）`);
    this.name = "ArtifactWriteError";
  }
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

  putMetadata(runId: string, metadata: Record<string, unknown>): string {
    return this.putJson(runId, "metadata.json", metadata);
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

  readAttemptValidation(runId: string, attemptNumber: number): ValidationResult | null {
    return this.readJson(runId, this.attemptFile(attemptNumber, "validation.json")) as ValidationResult | null;
  }

  readAttemptReview(runId: string, attemptNumber: number): ReviewResult | null {
    return this.readJson(runId, this.attemptFile(attemptNumber, "review.json")) as ReviewResult | null;
  }

  readFinalStory(runId: string): string | null {
    return this.readText(runId, "story.md");
  }

  readFinalValidation(runId: string): ValidationResult | null {
    return this.readJson(runId, "validation.json") as ValidationResult | null;
  }

  readFinalReview(runId: string): ReviewResult | null {
    return this.readJson(runId, "review.json") as ReviewResult | null;
  }

  // ---------------------------------------------------------------------------
  // §28 promoteAttemptToFinal：Windows 没有可靠符号链接，用复制/重写落地。
  // ---------------------------------------------------------------------------

  promoteAttempt(runId: string, attemptNumber: number): Record<string, string> {
    const promoted: Record<string, string> = {};
    const dir = this.attemptDirPath(runId, attemptNumber);
    if (!existsSync(dir)) throw new Error(`Attempt ${attemptNumber} 不存在：${dir}`);

    for (const filename of ["story.md", "validation.json", "review.json"]) {
      const source = join(dir, filename);
      if (!existsSync(source)) continue;
      const target = this.rootFile(runId, filename);
      try {
        copyFileSync(source, target);
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
    const tmpPath = join(dir, `.${filename.split("/").join("_")}.tmp`);
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
