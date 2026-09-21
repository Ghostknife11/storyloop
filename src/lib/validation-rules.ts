/**
 * §9/§10/§11/§13/§14/§15 v0.6.0 硬性规则：每条规则只回答一个是/否问题，返回 null 表示未命中。
 * §3：优先确定性规则，只有结尾检查使用轻量启发式；禁止把这里做成第二个 Reviewer。
 * §5：本文件只产出 warning / error 两种 severity。
 */

import type { StoryConfig } from "@/types/story-config";
import type { ValidationIssue, ValidationIssueCode, ValidationSeverity } from "@/types/validation-result";

/** §9 统一输入：只需要 StoryConfig 与 Story 本身。 */
export interface ValidationInput {
  config: StoryConfig;
  story: string;
}

/** §9 允许拆分小 Validator，统一由 StoryValidator 聚合；§7 不做 Plugin Registry。 */
export interface ValidationRule {
  readonly code: ValidationIssueCode;
  check(input: ValidationInput): ValidationIssue | null;
}

function issue(code: ValidationIssueCode, severity: ValidationSeverity, message: string): ValidationIssue {
  return { code, severity, message };
}

/**
 * §11 稳定近似计数：CJK 字符按「个」计，拉丁字母 / 数字连续串按「词」计，标点与空白不计。
 * 中文项目禁用 len(text.split())——中文没有空格分词，会把整篇当成一个词。
 */
const CJK_CHAR = /[\u3040-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

export function countStoryLength(text: string): number {
  if (typeof text !== "string" || !text) return 0;
  const cjk = text.match(CJK_CHAR);
  const latin = text.match(LATIN_WORD);
  return (cjk ? cjk.length : 0) + (latin ? latin.length : 0);
}

/** §11 长度下限：actual_length < max(300, target_words * 0.15) 才算明显失败。§12 不要求精确达标。 */
export function minimumLengthFloor(targetWords: number): number {
  const target = Number.isFinite(targetWords) && targetWords > 0 ? targetWords : 0;
  return Math.max(300, Math.floor(target * 0.15));
}

/** §10 EmptyContentValidator：None / "" / "   " 一律 EMPTY_CONTENT。 */
export const emptyContentRule: ValidationRule = {
  code: "EMPTY_CONTENT",
  check(input) {
    const story = input.story;
    if (typeof story !== "string" || !story.trim()) {
      return issue("EMPTY_CONTENT", "error", "正文为空，没有可校验的内容。");
    }
    return null;
  },
};

/** §16 INVALID_OUTPUT：拿到的是错误 JSON / API 错误字符串 / 明显错误对象，而不是小说正文。 */
const API_ERROR_HEAD = /^\[?\s*api\s+error\s*\]?\s*[:：]/i;
const ERROR_PREFIX = /^error\s*[:：]/i;
const PLACEHOLDER_OBJECTS = new Set(["[object Object]", "undefined", "null"]);

function looksLikeInvalidOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (PLACEHOLDER_OBJECTS.has(trimmed)) return true;
  if (API_ERROR_HEAD.test(trimmed) || ERROR_PREFIX.test(trimmed)) return true;
  // 整篇正文就是一个 JSON 对象 / 数组：这不是小说，是模型回错了结构。
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "object" && parsed !== null;
    } catch {
      return false;
    }
  }
  return false;
}

export const invalidOutputRule: ValidationRule = {
  code: "INVALID_OUTPUT",
  check(input) {
    const story = input.story;
    if (typeof story !== "string" || !story.trim()) return null;
    if (looksLikeInvalidOutput(story)) {
      return issue("INVALID_OUTPUT", "error", "拿到的不是小说正文，而是错误输出（错误 JSON / API 错误串 / 错误对象）。");
    }
    return null;
  },
};

/** §11 MinimumLengthValidator：只识别明显失败，target_words 差一点不算失败（§12）。 */
export const minimumLengthRule: ValidationRule = {
  code: "TOO_SHORT",
  check(input) {
    const story = input.story;
    if (typeof story !== "string" || !story.trim()) return null;
    const actual = countStoryLength(story);
    const floor = minimumLengthFloor(input.config.target_words);
    if (actual < floor) {
      return issue(
        "TOO_SHORT",
        "error",
        `正文长度 ${actual} 明显短于目标字数（下限 ${floor}）。`,
      );
    }
    return null;
  },
};

const OPENING_QUOTES = new Set(["“", "‘", "「", "『"]);
const CLOSING_QUOTES = new Set(["”", "’", "」", "』"]);
const CLAUSE_TAIL = /[，,、；;：:]$/;

function quotesBalanced(text: string): boolean {
  let open = 0;
  let close = 0;
  for (const ch of text) {
    if (OPENING_QUOTES.has(ch)) open += 1;
    else if (CLOSING_QUOTES.has(ch)) close += 1;
  }
  return open === close;
}

function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

/** §13 PossibleTruncationValidator：引号未闭合 / 结尾停在分句中间。不过度推断。 */
export const truncationRule: ValidationRule = {
  code: "POSSIBLE_TRUNCATION",
  check(input) {
    const story = input.story;
    if (typeof story !== "string" || !story.trim()) return null;
    const trimmed = story.trim();
    if (!quotesBalanced(trimmed)) {
      return issue("POSSIBLE_TRUNCATION", "error", "正文疑似被截断：引号没有闭合。");
    }
    const lastLine = lastMeaningfulLine(trimmed);
    if (lastLine && CLAUSE_TAIL.test(lastLine)) {
      return issue("POSSIBLE_TRUNCATION", "error", "正文疑似被截断：结尾停在句子中间。");
    }
    return null;
  },
};

/** §15 EndingPresenceValidator：最后一行没有任何终止标点 → warning。轻量启发式，不变成 Review。 */
const TERMINAL_PUNCTUATION = /[。！？!?….…]$/;
const TRAILING_CLOSERS = /[”’」』》）)]+$/u;

function endsWithTerminalPunctuation(text: string): boolean {
  const stripped = text.trimEnd().replace(TRAILING_CLOSERS, "");
  return TERMINAL_PUNCTUATION.test(stripped);
}

export const endingPresenceRule: ValidationRule = {
  code: "MISSING_ENDING",
  check(input) {
    const story = input.story;
    if (typeof story !== "string" || !story.trim()) return null;
    const lastLine = lastMeaningfulLine(story.trim());
    if (lastLine && !endsWithTerminalPunctuation(lastLine)) {
      return issue("MISSING_ENDING", "warning", "正文结尾不像一个完整收束。");
    }
    return null;
  },
};

/** §14 Protagonist Presence：配置了 protagonist.name 才检查；未配置直接跳过。 */
export const protagonistPresenceRule: ValidationRule = {
  code: "MISSING_PROTAGONIST",
  check(input) {
    const name = input.config.protagonist?.name?.trim();
    if (!name) return null;
    const story = input.story;
    if (typeof story !== "string" || !story.trim()) return null;
    if (!story.toLowerCase().includes(name.toLowerCase())) {
      return issue("MISSING_PROTAGONIST", "error", `正文中未找到主角「${name}」。`);
    }
    return null;
  },
};

/** §7 聚合顺序固定：先看是不是有效输出，再看内容层面的硬规则。 */
export const STORY_VALIDATION_RULES: readonly ValidationRule[] = [
  invalidOutputRule,
  emptyContentRule,
  minimumLengthRule,
  truncationRule,
  protagonistPresenceRule,
  endingPresenceRule,
];
