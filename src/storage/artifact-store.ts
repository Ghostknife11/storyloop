import { mkdirSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { StoryConfig } from "@/types/story-config";
import type { BeatPlan } from "@/types/beat-plan";

/**
 * §13/§22 ArtifactStore：只负责创建目录、保存 JSON / Markdown / Metadata、返回路径。
 * 不得调用 LLM、分析内容、决定 Pipeline 流程。§22 File System Only。
 */

export class ArtifactStore {
  private runsRoot: string;

  constructor(baseDir?: string) {
    this.runsRoot = resolve(baseDir || join(process.cwd(), "runs"));
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
    mkdirSync(dir, { recursive: true });
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

  putMetadata(runId: string, metadata: Record<string, unknown>): string {
    return this.putJson(runId, "metadata.json", metadata);
  }

  runExists(runId: string): boolean {
    return existsSync(this.runDir(runId));
  }

  private putJson(runId: string, filename: string, data: unknown): string {
    return this.putText(runId, filename, JSON.stringify(data, null, 2));
  }

  /** §21 原子写入：临时文件 → rename，避免进程中断留下半个 JSON / Markdown。 */
  private putText(runId: string, filename: string, content: string): string {
    const dir = this.runDir(runId);
    const finalPath = join(dir, filename);
    const tmpPath = join(dir, `.${filename}.tmp`);
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, finalPath);
    return finalPath;
  }
}
