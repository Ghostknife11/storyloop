/**
 * v2.2.0 Ports：稿件仓储端口（TASK §31 DocumentRepository）。
 *
 * 用例与路由只认这个接口：列、读、写。它们不知道稿件是 documents/<id>.json、
 * 不知道正文存在哪个字段里，更不知道这些文件挂在哪个项目目录下。
 *
 * §4 明确不做 `GenericRepository<T>`：这里就是 StoryDocument 自己的形状。
 *
 * 同步方法（与 ArtifactStore / ExperimentStore / ProjectRepository 一致）：
 * 落盘就是一次 rename，包一层 Promise 只会让调用方多写一个没有意义的 await。
 */

import type { StoryDocument } from "@/domain/story-document";

export interface DocumentRepository {
  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  readonly root: string;

  /** 某个项目下全部稿件 id，按字典序；目录不存在时是空数组。 */
  listDocumentIds(projectId: string): string[];

  exists(projectId: string, documentId: string): boolean;

  /** 项目下 documents/ 目录的绝对路径（测试与调试用）。 */
  resolveDocumentsDir(projectId: string): string;

  putDocument(document: StoryDocument): void;

  /** 读不回来一律 null（与 storyDocumentOf 同一约定：不猜）。 */
  readDocument(projectId: string, documentId: string): StoryDocument | null;
}
