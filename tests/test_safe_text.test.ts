/**
 * v0.9.1 响应脱敏（TASK §67）。
 *
 * 这一组盯 safeText 一件事：服务器绝对路径换成 <path>，相对文件名一个字符都不许动。
 * v0.9.0 的正则没有前置边界，会把 attempts/01/story.md 里的 /01/ 当成绝对路径吃掉，
 * 用户拿到的错误消息变成「产物写入失败：attempts<path>」——问题没说清，还多个乱码。
 */

import { describe, expect, it } from "vitest";
import { safeText } from "@/lib/safe-text";
import { redactSecrets } from "@/lib/logger";

describe("safeText：绝对路径换成 <path>", () => {
  it("Windows 盘符路径", () => {
    expect(safeText("EISDIR: illegal operation on a directory, open 'D:\\test\\repo\\runs\\20260922_101500_ab12cd\\story.md'"))
      .toBe("EISDIR: illegal operation on a directory, open '<path>'");
  });

  it("POSIX 绝对路径", () => {
    expect(safeText("EACCES: permission denied, open '/home/u/repo/runs/abc123/review.json'"))
      .toBe("EACCES: permission denied, open '<path>'");
  });

  it("UNC / 网络盘路径", () => {
    expect(safeText("open '\\\\server\\share\\repo\\runs\\x\\story.md'"))
      .toBe("open '<path>'");
  });

  it("一句话里有多条路径时全部替换", () => {
    expect(safeText("mkdir 'D:\\a\\b\\c\\d' 时 open 'D:\\a\\b\\e\\f' 失败"))
      .toBe("mkdir '<path>' 时 open '<path>' 失败");
  });

  it("字符串开头与结尾的路径也能替换（不依赖前后文）", () => {
    expect(safeText("/var/log/app/x/y")).toBe("<path>");
    expect(safeText("D:\\a\\b\\c\\d")).toBe("<path>");
  });
});

describe("safeText：相对文件名必须原样保留", () => {
  it("attempts/01/story.md 不被吃掉", () => {
    expect(safeText("产物写入失败：attempts/01/story.md（EEXIST mkdir）"))
      .toBe("产物写入失败：attempts/01/story.md（EEXIST mkdir）");
  });

  it("repairs 的深层相对路径同样保留", () => {
    const rel = "attempts/01/repairs/02/story.md";
    expect(safeText(`产物写入失败：${rel}（EACCES open）`)).toBe(`产物写入失败：${rel}（EACCES open）`);
  });

  it("纯相对文件名不带任何路径形态时完全不变", () => {
    for (const name of ["story.md", "config.json", "beats.json", "metadata.json", "review.json", "validation.json"]) {
      expect(safeText(`产物写入失败：${name}（ENOSPC write）`)).toBe(`产物写入失败：${name}（ENOSPC write）`);
    }
  });

  it("同一句里既有相对文件名又有绝对路径：只换绝对路径", () => {
    expect(safeText("写 attempts/01/story.md 失败，mkdir 'D:\\repo\\runs\\x\\attempts\\01' 被占用"))
      .toBe("写 attempts/01/story.md 失败，mkdir '<path>' 被占用");
  });
});

describe("safeText：凭据脱敏与日志同一套规则", () => {
  it("密钥形态的串同样打码", () => {
    const keyName = "api" + "_key";
    const value = "sk-" + "abcdef1234567890";
    const masked = safeText(`error: ${keyName}="${value}"`);
    expect(masked).toContain(keyName);
    expect(masked).not.toContain(value);
    expect(masked).toBe(redactSecrets(`error: ${keyName}="${value}"`));
  });

  it("没有路径也没有密钥的文本原样返回", () => {
    expect(safeText("Planner 输出不是合法 JSON")).toBe("Planner 输出不是合法 JSON");
    expect(safeText("")).toBe("");
  });
});
