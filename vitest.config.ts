import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: ["e2e/**", "node_modules/**"],
  },
  resolve: {
    // v2.0.0 六层路径：@/<layer>/… 一律指向 src/<layer>/…。
    // 迁移结束后不再需要 v1.x 兼容映射——所有 src/、tests/、scripts/
    // 的导入都写成真实的新路径（tests/test_architecture_layers.test.ts 会守住这一点）。
    // 顺序即优先级：长的在前，避免前缀互相吞掉。
    alias: [
      { find: "@/domain", replacement: path.resolve(__dirname, "./src/domain") },
      { find: "@/ports", replacement: path.resolve(__dirname, "./src/ports") },
      { find: "@/engine", replacement: path.resolve(__dirname, "./src/engine") },
      { find: "@/analysis", replacement: path.resolve(__dirname, "./src/analysis") },
      { find: "@/application", replacement: path.resolve(__dirname, "./src/application") },
      { find: "@/infrastructure", replacement: path.resolve(__dirname, "./src/infrastructure") },
      { find: "@/interface", replacement: path.resolve(__dirname, "./src/interface") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
});
