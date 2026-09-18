import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPromptTemplate, PromptTemplateError } from "@/lib/prompt-template";
import { PromptBuilder } from "@/lib/prompt-builder";

let tmp: string | null = null;
afterEach(() => {
  if (tmp) { rmSync(tmp, { recursive: true, force: true }); tmp = null; }
});

describe("prompt template loading", () => {
  it("template exists and loads", async () => {
    const tpl = await loadPromptTemplate();
    expect(tpl).toContain("{{title}}");
    expect(tpl).toContain("{{genre}}");
    expect(tpl).toContain("{{premise}}");
    expect(tpl).toContain("{{target_words}}");
    expect(tpl).toContain("{{style}}");
    expect(tpl).toContain("{{extra_requirements}}");
  });

  it("missing template fails clearly", async () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-tpl-"));
    const missing = join(tmp, "nope.txt");
    expect(existsSync(missing)).toBe(false);
    await expect(loadPromptTemplate(missing)).rejects.toThrow(PromptTemplateError);
    await expect(loadPromptTemplate(missing)).rejects.toThrow(/读取失败/);
  });

  it("empty template fails clearly", async () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-tpl-"));
    const path = join(tmp, "story.txt");
    writeFileSync(path, "   ", "utf8");
    await expect(loadPromptTemplate(path)).rejects.toThrow(/为空/);
  });

  it("PromptBuilder on missing template fails clearly（Case F）", () => {
    tmp = mkdtempSync(join(tmpdir(), "storyloop-tpl-"));
    const missing = join(tmp, "removed-story.txt");
    expect(() => new PromptBuilder(missing)).toThrow(PromptTemplateError);
  });
});
