/**
 * v2.2.0 Ports：项目仓储端口（TASK §4 ProjectRepository）。
 *
 * 用例与路由只认这个接口：建、读、列、改、归档。它们不知道项目是一个目录、
 * 不知道 project.json 叫什么、更不知道这些文件在哪个盘上——那是 Infrastructure 的事。
 *
 * §4 明确不做 `GenericRepository<T>`：这里就是 Project 自己的形状，一个方法一副职责。
 * 与 ExperimentRepository / ArtifactStore 并列，而不是它们的特例。
 *
 * 同步方法（与 ArtifactStore、ExperimentStore 一致）：落盘就是一次 rename，
 * 包一层 Promise 只会让调用方多写一个没有意义的 await。用例层按本仓库既有约定
 * 仍以 async 门面对外。
 */

import type { Project } from "@/domain/project";

export interface ProjectRepository {
  /** 测试与调试用：projects/ 根的绝对路径（API 响应不得返回它，§67）。 */
  readonly root: string;

  /** 目录不存在 / project.json 读不回来 → false。 */
  exists(projectId: string): boolean;

  resolveProjectDir(projectId: string): string;

  /** 建目录；已存在就复用（是否允许覆盖由用例判断，存储层不判断）。 */
  createProjectDirectory(projectId: string): string;

  putProject(project: Project): void;

  /** 读不回来一律 null（与 runManifestOf 同一约定：不猜）。 */
  readProject(projectId: string): Project | null;

  /** 全部项目 id，按字典序。 */
  listProjectIds(): string[];
}
