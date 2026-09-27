/**
 * v2.2.0 Project：一个长期创作容器（TASK §3/§5）。
 *
 * 它把已经有能力的东西组织起来，不新增任何生成能力：一次 Run 的产物仍躺在
 * runs/ 下不可变，一个 Project 只是「这些 Run、这些稿件、这些导出属于同一件事」。
 *
 * 关于 Run 归属（TASK §6）——单一真源是 run-manifest.json 里的
 * `workspace.projectId`，不是这个模型的字段：
 *   - Run 不可变，所以它记下来的归属说了算；项目改名、归档都不该改写成千上万份清单；
 *   - project.json 因此不再存第二份 runId 列表。两份会腐烂的真源比没有真源更糟：
 *     项目里显示 5 个 Run，而其中一个的清单写着别人的项目，用户没有任何办法判断该信谁。
 * 「Project 只保存 runId references，不复制完整 Run Artifacts」这条因此按字面执行——
 * 引用在 Manifest 里，正文一份都不复制。
 *
 * storyConfigRef / currentDocumentId 是可空的：工作区里「还没有当前稿件」「还没有关联配置」
 * 是正常状态，用 null 表示，不用可选链把「没有」和「没填」搅在一起。
 */

import {
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_NOTE_MAX,
  WorkspaceValidationError,
  flagOf,
  isoTimestampOf,
  isWorkspaceId,
  optionalTextOf,
  rejectSecretBearingKeys,
  rejectUnknownKeys,
  textOf,
} from "@/domain/workspace";

/** 项目状态：active 正常出现在列表里；archived 只是不再默认展示，数据一份不删（TASK §40）。 */
export type ProjectStatus = "active" | "archived";

export const PROJECT_STATUSES = ["active", "archived"] as const;

/** TASK §3 项目模型。 */
export interface Project {
  schemaVersion: string;
  id: string;
  /** 不可信输入：只做展示，绝不参与路径拼接（§42）。 */
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  /** 不透明引用（配置标题或外部编号），不是文件系统路径。 */
  storyConfigRef: string | null;
  /** 工作区当前稿件；null = 还没有稿件。 */
  currentDocumentId: string | null;
  isFavorite: boolean;
}

/** TASK §3/§36 列表项要的那几样，正文不进来。 */
export interface ProjectListItem {
  id: string;
  name: string;
  status: ProjectStatus;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  currentDocumentId: string | null;
}

export function projectListItemOf(project: Project): ProjectListItem {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    isFavorite: project.isFavorite,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    currentDocumentId: project.currentDocumentId,
  };
}

const PROJECT_KEYS = [
  "schemaVersion",
  "id",
  "name",
  "status",
  "createdAt",
  "updatedAt",
  "storyConfigRef",
  "currentDocumentId",
  "isFavorite",
] as const;

function statusOf(raw: unknown): ProjectStatus {
  if (raw !== "active" && raw !== "archived") {
    throw new WorkspaceValidationError(`status 只能是 active / archived（实际 ${String(raw)}）`);
  }
  return raw;
}

function currentDocumentIdOf(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (!isWorkspaceId(raw)) {
    throw new WorkspaceValidationError("currentDocumentId 不合法：只能是单个目录名");
  }
  return raw;
}

/** §51 结构校验：形状不对就抛 WorkspaceValidationError。 */
export function validateProject(raw: unknown): Project {
  rejectSecretBearingKeys(raw);
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, PROJECT_KEYS, "project");

  const schemaVersion = textOf(r.schemaVersion, "schemaVersion", 16);
  if (schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw new WorkspaceValidationError(`schemaVersion 只支持 ${WORKSPACE_SCHEMA_VERSION}（实际 ${schemaVersion}）`);
  }
  if (!isWorkspaceId(r.id)) {
    throw new WorkspaceValidationError("id 不合法：只能是单个目录名（字母数字开头，不含路径分隔符）");
  }

  return {
    schemaVersion,
    id: r.id,
    name: textOf(r.name, "name", 120),
    status: statusOf(r.status),
    createdAt: isoTimestampOf(r.createdAt, "createdAt"),
    updatedAt: isoTimestampOf(r.updatedAt, "updatedAt"),
    storyConfigRef: optionalTextOf(r.storyConfigRef, "storyConfigRef", WORKSPACE_NOTE_MAX) ?? null,
    currentDocumentId: currentDocumentIdOf(r.currentDocumentId),
    isFavorite: flagOf(r.isFavorite, "isFavorite", false),
  };
}

/** 读回时归一化：磁盘上的 project.json 被手改坏时返回 null，由调用方按「不存在」处理。 */
export function projectOf(raw: unknown): Project | null {
  try {
    return validateProject(raw);
  } catch {
    return null;
  }
}

/**
 * TASK §30 PATCH 的白名单：只有这五个字段可改。
 * id 与 createdAt 不可改——改了就不是同一个项目了；schemaVersion 由服务端给。
 */
const PROJECT_PATCH_KEYS = ["name", "status", "isFavorite", "currentDocumentId", "storyConfigRef"] as const;

/** PATCH 只做「结构合法」检查：合并与 updatedAt 由用例负责。 */
export function validateProjectPatch(raw: unknown): Partial<Project> {
  rejectSecretBearingKeys(raw);
  const r = raw as Record<string, unknown>;
  rejectUnknownKeys(r, PROJECT_PATCH_KEYS, "project");
  if (Object.keys(r).length === 0) {
    throw new WorkspaceValidationError("PATCH 请求至少要带一个可改字段");
  }

  const patch: Partial<Project> = {};
  if (r.name !== undefined) patch.name = textOf(r.name, "name", 120);
  if (r.status !== undefined) patch.status = statusOf(r.status);
  if (r.isFavorite !== undefined) patch.isFavorite = flagOf(r.isFavorite, "isFavorite", false);
  if (r.currentDocumentId !== undefined) patch.currentDocumentId = currentDocumentIdOf(r.currentDocumentId);
  if (r.storyConfigRef !== undefined) {
    patch.storyConfigRef = optionalTextOf(r.storyConfigRef, "storyConfigRef", WORKSPACE_NOTE_MAX) ?? null;
  }
  return patch;
}

/** 收藏 / 归档只改几个字段，其余原样——所以更新走整对象覆盖，不发明增量协议。 */
export function withProjectPatch(project: Project, patch: Partial<Project>, updatedAt: string): Project {
  return validateProject({
    ...project,
    ...patch,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    id: project.id,
    createdAt: project.createdAt,
    updatedAt: isoTimestampOf(updatedAt, "updatedAt"),
  });
}
