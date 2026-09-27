/**
 * v2.0.0 健康与能力报告（TASK §45/§46）。
 *
 * §45「能力登记只放真实布尔」：这里没有一个字段是「计划支持」。每个布尔都由调用方
 * 现查现给（探测在 Infrastructure，见 infrastructure/health/health-probe.ts），
 * 组装函数本身不读环境变量、不碰文件系统——于是它可以在测试里被完整验证。
 *
 * §46 明确不许出现的东西：API Key、baseUrl、任何凭据或敏感地址。这里只回答
 * 「配没配、能不能写、跑不跑得起来」三个是非题，一个值都不外泄。
 */

/** §45 能力登记：四个布尔，全部是真查出来的。 */
export interface CapabilityReport {
  /** 服务端环境里配了模型提供方（有可用的 LLM_API_KEY）。 */
  llm_configured: boolean;
  /** 产物目录存在且可写。 */
  storage_writable: boolean;
  /** 受控实验可用：定义存储与生成路径都在同一个装配里才为 true。 */
  experiments: boolean;
}

export interface HealthReport {
  /** 两个必要条件都成立才是 ok；否则 degraded——不假装健康。 */
  status: "ok" | "degraded";
  version: string;
  capabilities: CapabilityReport;
}

export interface HealthProbes {
  version: string;
  llmConfigured: boolean;
  storageWritable: boolean;
}

/** 把三项探测结果组装成报告。纯函数，便于测试逐条覆盖。 */
export function assembleHealthReport(probes: HealthProbes): HealthReport {
  const { llmConfigured, storageWritable } = probes;
  return {
    status: llmConfigured && storageWritable ? "ok" : "degraded",
    version: probes.version,
    capabilities: {
      llm_configured: llmConfigured,
      storage_writable: storageWritable,
      // 实验能力与实验存储同生共死：存储注入了才有这一项
      experiments: storageWritable,
    },
  };
}
