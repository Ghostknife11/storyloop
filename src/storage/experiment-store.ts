import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
  experimentDefinitionOf,
  isExperimentId,
  type ExperimentDefinition,
  type ExperimentResult,
  type ExperimentRunIndex,
} from "@/types/experiment";

/**
 * v1.7.0 实验存储：只管 experiments/<id>/ 下三个 JSON 的读写。
 * 与 ArtifactStore 同一套纪律——不调 LLM、不分析内容、不决定流程；
 * 原子写入（临时文件 → rename），失败时消息里只有相对文件名，不带服务器
 * 绝对路径（§67，与 ArtifactWriteError 同一个理由）。
 *
 * 目录布局（TASK §22）：
 *   experiments/
 *     <experimentId>/
 *       definition.json   不可变的实验定义（要改就复制成新实验）
 *       runs.json         展开后的格子 → 跑出哪个 runId，失败时记在哪一步
 *       results.json      分组结果与汇总
 *
 * 根目录与 runs/ 并列：`resolve(runsDir, "..", "experiments")`。
 * 一次实验的样本越多，产出的 Run 就越多，但每个 Run 仍然是 runs/ 下一个
 * 完整的普通 Run——这里只放索引与结论，不复制任何正文。
 */

/** §22 三个文件名。 */
const DEFINITION_FILE = "definition.json";
const RUNS_FILE = "runs.json";
const RESULTS_FILE = "results.json";

/** 磁盘满 / 权限不足 / 目录被占用。消息只带相对文件名（§67）。 */
export class ExperimentWriteError extends Error {
  constructor(
    readonly filename: string,
    cause: unknown,
  ) {
    super(`实验数据写入失败：${filename}（${failureCodeOf(cause)}）`);
    this.name = "ExperimentWriteError";
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

export class ExperimentStore {
  private experimentsRoot: string;

  /**
   * runsRoot：Run 产物根目录（与 ArtifactStore 同一个根）。
   * 实验目录取它的上一级 sibling：`<runs 的父目录>/experiments`。
   * 传一个显式路径则视为 experiments 根本身（测试直接用）。
   */
  constructor(runsRoot?: string) {
    const root = resolve(runsRoot || join(process.cwd(), "runs"));
    this.experimentsRoot = resolve(root, "..", "experiments");
  }

  /** 测试与调试用：实验目录的绝对路径（API 响应不得返回它，§67）。 */
  get root(): string {
    return this.experimentsRoot;
  }

  /**
   * §35 Path Traversal 防护：experimentId 已经过 idOf 校验，这里再做一次 containment check。
   * 根目录自身也不算——`resolve(root, ".")` 与 `resolve(root, "")` 都等于根，
   * 放过去就等于把 experiments/ 根当成一个实验来读写（v1.7.1 补上这一条）。
   */
  private experimentDir(experimentId: string): string {
    const dir = resolve(this.experimentsRoot, experimentId);
    if (dir === this.experimentsRoot || !dir.startsWith(this.experimentsRoot + sep)) {
      throw new ExperimentWriteError(experimentId, undefined);
    }
    return dir;
  }

  resolveExperimentDir(experimentId: string): string {
    return this.experimentDir(experimentId);
  }

  /** 目录不存在（或 definition.json 读不回来）→ 当作不存在。 */
  exists(experimentId: string): boolean {
    try {
      return existsSync(this.experimentDir(experimentId)) && this.readDefinition(experimentId) !== null;
    } catch {
      return false;
    }
  }

  /** 建目录；已存在就复用（是否允许重跑由 service 层判断，存储层不判断）。 */
  createExperimentDirectory(experimentId: string): string {
    const dir = this.experimentDir(experimentId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new ExperimentWriteError(DEFINITION_FILE, e);
    }
    return dir;
  }

  putDefinition(experimentId: string, definition: ExperimentDefinition): void {
    this.putJson(experimentId, DEFINITION_FILE, definition);
  }

  putRuns(experimentId: string, index: ExperimentRunIndex): void {
    this.putJson(experimentId, RUNS_FILE, index);
  }

  putResults(experimentId: string, result: ExperimentResult): void {
    this.putJson(experimentId, RESULTS_FILE, result);
  }

  /**
   * 读定义。文件缺失、JSON 坏掉、或与当前 schemaVersion 不兼容（读回来校验不过）
   * 都返回 null——调用方按「不存在」处理，不猜（与 `runManifestOf` 同一套做法）。
   */
  readDefinition(experimentId: string): ExperimentDefinition | null {
    return experimentDefinitionOf(this.readJson(experimentId, DEFINITION_FILE));
  }

  readRuns(experimentId: string): ExperimentRunIndex | null {
    const raw = this.readJson(experimentId, RUNS_FILE);
    if (raw === null) return null;
    if (!Array.isArray(raw.entries)) return null;
    return raw as unknown as ExperimentRunIndex;
  }

  readResults(experimentId: string): ExperimentResult | null {
    const raw = this.readJson(experimentId, RESULTS_FILE);
    if (raw === null) return null;
    if (!Array.isArray(raw.runs) || typeof raw.status !== "string") return null;
    return raw as unknown as ExperimentResult;
  }

  /** experiments/ 下所有实验 id，按目录名字典序。 */
  listExperimentIds(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.experimentsRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    // 手放进来的目录名也可能不是合法 id（`.` 开头、带分隔符……）：列不出来就别列，
    // 更不该拿它去拼路径
    return names.filter((name) => isExperimentId(name) && this.exists(name)).sort();
  }

  // ---------------------------------------------------------------------------
  // 内部：路径解析与原子写入
  // ---------------------------------------------------------------------------

  private putJson(experimentId: string, filename: string, data: unknown): void {
    this.putText(experimentId, filename, JSON.stringify(data, null, 2));
  }

  /** 与 ArtifactStore 同一套原子语义：先写同目录临时文件再 rename。 */
  private putText(experimentId: string, filename: string, content: string): void {
    const finalPath = resolve(this.experimentDir(experimentId), filename);
    const tmpPath = join(join(finalPath, ".."), `.${basename(finalPath)}.tmp`);
    try {
      mkdirSync(this.experimentDir(experimentId), { recursive: true });
      writeFileSync(tmpPath, content, "utf8");
      renameSync(tmpPath, finalPath);
    } catch (e) {
      throw new ExperimentWriteError(filename, e);
    }
  }

  private readJson(experimentId: string, filename: string): Record<string, unknown> | null {
    const path = resolve(this.experimentDir(experimentId), filename);
    if (!existsSync(path)) return null;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
