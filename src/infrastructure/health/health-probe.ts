/**
 * v2.0.0 健康探测（Infrastructure，TASK §45/§46）。
 *
 * 三个探测都是真的去看：版本读 VERSION 文件、提供方看服务端环境里有没有密钥、
 * 存储真的去 access 一次。全是只读操作，不删不改任何东西。
 *
 * 这里也不外泄任何东西：providerConfigured 只回答「有没有」，绝不返回那串密钥，
 * baseUrl 同样不进报告（§46）。密钥只在 llm/ 目录里被读一次，那也是全仓唯一
 * 允许它出现的地方（§33）。
 */

import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import { appSettings } from "@/infrastructure/config/app-config";
import { projectVersion } from "@/infrastructure/config/version";

/** 服务端环境里配了可用的模型提供方吗（只回答有没有）。 */
export function providerConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY?.trim());
}

/**
 * 产物目录可写吗。
 *
 * 目录不存在就建出来再判：这是应用自己的数据目录，第一次跑之前本来也该有；
 * 建完仍然不可写才算真的不可写。只建目录、不写文件，不碰任何既有内容。
 */
export function storageWritable(runsDir?: string): boolean {
  const dir = runsDir ?? appSettings().runsDir;
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** 三项探测一次拿全（版本号在调用时读，改 VERSION 无需重新构建）。 */
export function healthProbes(runsDir?: string): { version: string; llmConfigured: boolean; storageWritable: boolean } {
  return {
    version: projectVersion(),
    llmConfigured: providerConfigured(),
    storageWritable: storageWritable(runsDir),
  };
}
