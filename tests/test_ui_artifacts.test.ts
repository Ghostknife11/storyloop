import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { attemptArtifactPath } from "@/lib/artifacts-view";
import type { RunOk } from "@/lib/generate-service";

/**
 * §42 产物清单的展示口径：Run 响应里的 artifacts 是**运行根目录**那一层，
 * 看某一次 Attempt 时只有 promote 清单里那四个文件在 attempt 目录下真实存在。
 * 运行级文件（config / beat_plan / metadata / beat_validation）不能加 attempts/NN/ 前缀，
 * 否则清单会列出根本不存在的路径。
 */

const runArtifacts: Record<string, string> = {
  config: "config.json",
  beat_plan: "beats.json",
  story: "story.md",
  metadata: "metadata.json",
  beat_validation: "beat-validation.json",
  validation: "validation.json",
  review: "review.json",
  quality: "quality.json",
};

describe("attemptArtifactPath（§42）", () => {
  it("看入选 Attempt 时全部是 Run 根目录路径", () => {
    for (const [key, file] of Object.entries(runArtifacts)) {
      expect(attemptArtifactPath(key, file, 2, 2)).toBe(file);
    }
  });

  it("看非入选 Attempt 时，只有 attempt 目录里真实存在的四个文件加前缀", () => {
    expect(attemptArtifactPath("story", "story.md", 1, 2)).toBe("attempts/01/story.md");
    expect(attemptArtifactPath("validation", "validation.json", 3, 2)).toBe("attempts/03/validation.json");
    expect(attemptArtifactPath("review", "review.json", 1, 2)).toBe("attempts/01/review.json");
    expect(attemptArtifactPath("quality", "quality.json", 1, 2)).toBe("attempts/01/quality.json");
  });

  it("运行级文件不加前缀：attempt 目录里没有这些文件", () => {
    expect(attemptArtifactPath("config", "config.json", 1, 2)).toBe("config.json");
    expect(attemptArtifactPath("beat_plan", "beats.json", 1, 2)).toBe("beats.json");
    expect(attemptArtifactPath("metadata", "metadata.json", 1, 2)).toBe("metadata.json");
    expect(attemptArtifactPath("beat_validation", "beat-validation.json", 1, 2)).toBe("beat-validation.json");
  });

  it("编号不足两位补零；没有在看的 Attempt（0）时不加前缀", () => {
    expect(attemptArtifactPath("story", "story.md", 7, 2)).toBe("attempts/07/story.md");
    expect(attemptArtifactPath("story", "story.md", 0, 2)).toBe("story.md");
  });
});

/** v1.4.1：RunOk 的 beat_validation_error 与 validation_error / review_error 同一套约定
 *  ——只在真的有错误时带上这个键（跳过这一步时整个键不出现）。*/
describe("RunOk.beat_validation_error（v1.4.1）", () => {
  const base: RunOk = {
    run_id: "20260925_101500_ab12cd",
    status: "completed",
    story: "正文",
    beat_plan: { beat_plan_version: "1", summary: "骨架", beats: [] },
    beat_validation: null,
    beat_validation_status: "failed",
    validation: null,
    validation_status: "not_started",
    review: null,
    review_status: "not_started",
    quality: null,
    artifacts: {},
    quality_status: "accepted",
    attempt_count: 1,
    selected_attempt: 1,
    repair_count: 0,
    attempts: [],
  };

  it("字段是可选的：没有错误时整个键不出现", () => {
    expect("beat_validation_error" in base).toBe(false);
  });

  it("有错误时带上安全摘要，且不可能是 undefined", () => {
    const withError: RunOk = { ...base, beat_validation_error: "结构校验模型超时" };
    expect(withError.beat_validation_error).toBe("结构校验模型超时");
  });
});

/** v1.4.1 §30/§37：「重新」与导出只认当前展示的那一版正文。
 *  这些开关都在 src/app/page.tsx 的闭包里，按仓库既有做法（tests/test_frontend_hardening.test.ts
 *  的 §35/§36）对源码钉死约定，而不是把整页渲染出来。*/
describe("v1.4.1 「重新」/ 导出只作用于当前展示的正文", () => {
  const page = readFileSync("src/app/page.tsx", "utf8");

  it("Review Again / Validate Again 送当前正文，且只在展示的就是 Run 落盘那版时带 run_id", () => {
    // 两个回调都送 baseStory（当前展示的那一版），不是 result?.story（落盘那版）
    expect(page).toMatch(/reviewStory\(\s*formToConfig\(form\),\s*baseStory,/);
    expect(page).toMatch(/validateStory\(\s*formToConfig\(form\),\s*baseStory,/);
    // run_id 只在这时出现：覆盖 run 目录里的结论才有意义
    expect(page.match(/shownStoryIsRunStory \? result\.run_id : undefined/g) ?? []).toHaveLength(2);
    expect(page).toContain("const shownStoryIsRunStory = !viewAttempt && !repairOverride;");
    // 结论覆盖只针对 run 级那一路：看别的 Attempt / 手动修订版时不动磁盘
    expect(page).not.toMatch(/reviewStory\([\s\S]{0,400}?run_id: result\.run_id/);
  });

  it("复制 / 下载导出的是当前展示的那一版，不是落盘那一版", () => {
    // 只取回调体：从 `const handleX` 到它自己那行 `  };`
    const bodyOf = (name: string): string => {
      const start = page.indexOf(`const ${name} = `);
      expect(start).toBeGreaterThan(-1);
      const end = page.indexOf("\n  };", start);
      expect(end).toBeGreaterThan(start);
      return page.slice(start, end);
    };
    for (const name of ["handleCopy", "handleDownload"]) {
      const body = bodyOf(name);
      expect(body).toContain("${shownStory}");
      expect(body).not.toContain("result?.story");
      expect(body).not.toContain("result.story");
    }
  });

  it("切换 Attempt 时过期响应被丢弃：序号不匹配就直接 return", () => {
    expect(page).toContain("const viewAttemptSeq = useRef(0);");
    expect(page).toContain("const seq = (viewAttemptSeq.current += 1);");
    expect(page).toContain("if (seq !== viewAttemptSeq.current) return;");
    // 点回被选中的 Attempt 那条早返回路径也要把序号往前推，否则它之前那次请求算最新
    expect(page).toContain("viewAttemptSeq.current += 1;");
  });
});
