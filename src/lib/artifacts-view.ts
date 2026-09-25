/**
 * §42 产物清单（runs/<run_id>/…）的展示口径。
 *
 * Run 响应里的 artifacts 是**运行根目录**那一层（config.json / beats.json / story.md /
 * metadata.json，加上校验 / 审阅 / 质量各自成功时才出现的文件）。查看某一次 Attempt 时，
 * 只有 promote 清单里那四个文件在 attempt 目录下真实存在——config / beat_plan /
 * metadata / beat_validation 是运行级文件，attempt 目录里没有它们。
 * 所以前缀只能加在那四个键上，否则清单会列出根本不存在的路径。
 */

/** §28 promote 清单：这四个文件 attempt 目录与 Run 根目录各有一份。 */
const ATTEMPT_SCOPED_ARTIFACTS = ["story", "validation", "review", "quality"] as const;

/** §42 单个产物在「当前看的这次 Attempt」下的展示路径。 */
export function attemptArtifactPath(
  key: string,
  file: string,
  viewingAttempt: number,
  selectedAttempt: number,
): string {
  if (viewingAttempt < 1 || viewingAttempt === selectedAttempt) return file;
  if (!(ATTEMPT_SCOPED_ARTIFACTS as readonly string[]).includes(key)) return file;
  return `attempts/${String(viewingAttempt).padStart(2, "0")}/${file}`;
}
