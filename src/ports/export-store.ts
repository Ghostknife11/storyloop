/**
 * v2.2.0 Ports：导出产物仓储端口（TASK §31 ExportRepository）。
 *
 * 管两样东西：
 *   1. 导出文件本身的字节 —— 落在 <project>/exports/<filename>；
 *   2. 导出历史           —— 落在 <project>/exports/index.json，只追加不改写。
 *
 * 历史之所以单独有个 index，而不是每次去扫目录：目录名只告诉我们「有个文件」，
 * 告诉我们不出它对应哪篇稿件、导出时内容长什么样。而 index.json 与文件同目录，
 * 删掉旧文件也只会留下一条对不上号的历史记录，读的时候自然忽略。
 *
 * 同步方法：与 ArtifactStore / ProjectRepository / DocumentRepository 一致，
 * 写盘就是 rename，包 Promise 只会让调用方多写一个没有意义的 await。
 */

import type { ExportResult } from "@/domain/export-artifact";

export interface ExportRepository {
  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  readonly root: string;

  /** 某个项目已有的导出文件名。重名时由用例层决定策略，这里不猜。 */
  listExportFilenames(projectId: string): string[];

  exists(projectId: string, filename: string): boolean;

  /** 导出文件字节的落地目录（同一项目内，已做 containment）。 */
  resolveExportsDir(projectId: string): string;

  /** 写字节。文件已存在时抛错——导出不该静默覆盖用户已经拿到手的文件。 */
  putArtifact(projectId: string, filename: string, bytes: Uint8Array): void;

  /** 读文件字节；文件不存在返回 null。 */
  readArtifact(projectId: string, filename: string): Uint8Array | null;

  /** 导出历史（index.json），按时间正序；坏条目会被 domain 的 exportHistoryOf 丢掉。 */
  listExports(projectId: string): ExportResult[];

  /** 追加一条历史记录。 */
  recordExport(projectId: string, result: ExportResult): void;
}
