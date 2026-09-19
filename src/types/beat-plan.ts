export class BeatPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeatPlanValidationError";
  }
}

/** §33 BeatPlan 自己的版本，与 config_version 分开管理。 */
export const BEAT_PLAN_VERSION = "1";

/** §5 StoryBeat：只描述剧情骨架，禁止未来字段（§6）。 */
export interface StoryBeat {
  id: number;
  purpose: string;
  event: string;
  characters: string[];
  conflict?: string;
  expected_outcome?: string;
}

/** §6 BeatPlan：beats 非空、id 唯一且从 1 连续。 */
export interface BeatPlan {
  beat_plan_version: string;
  summary?: string;
  beats: StoryBeat[];
}

/** §12 schema 校验（只查结构，不评质量——§55）。 */
export function validateBeatPlan(raw: unknown): BeatPlan {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(r.beats)) throw new BeatPlanValidationError("beats 必须是数组");
  if (r.beats.length === 0) throw new BeatPlanValidationError("beats 不能为空");

  const beats: StoryBeat[] = r.beats.map((b, i) => {
    const beat = (b ?? {}) as Record<string, unknown>;
    const id = beat.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      throw new BeatPlanValidationError(`beats[${i}].id 必须是正整数`);
    }
    const purpose = typeof beat.purpose === "string" ? beat.purpose.trim() : "";
    if (!purpose) throw new BeatPlanValidationError(`beats[${i}].purpose 不能为空`);
    const event = typeof beat.event === "string" ? beat.event.trim() : "";
    if (!event) throw new BeatPlanValidationError(`beats[${i}].event 不能为空`);
    if (!Array.isArray(beat.characters)) {
      throw new BeatPlanValidationError(`beats[${i}].characters 必须是数组`);
    }
    const out: StoryBeat = {
      id,
      purpose,
      event,
      characters: beat.characters.map((c) => String(c)),
    };
    if (typeof beat.conflict === "string" && beat.conflict.trim()) out.conflict = beat.conflict.trim();
    if (typeof beat.expected_outcome === "string" && beat.expected_outcome.trim()) {
      out.expected_outcome = beat.expected_outcome.trim();
    }
    return out;
  });

  // id 唯一且从 1 连续
  const ids = beats.map((b) => b.id).sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== i + 1) {
      throw new BeatPlanValidationError(`Beat id 必须从 1 开始连续（期望 ${i + 1}，实际 ${ids[i]}）`);
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new BeatPlanValidationError("Beat id 存在重复");
  }

  const plan: BeatPlan = {
    beat_plan_version: typeof r.beat_plan_version === "string" ? r.beat_plan_version : BEAT_PLAN_VERSION,
    summary: typeof r.summary === "string" && r.summary.trim() ? r.summary.trim() : undefined,
    beats,
  };
  return plan;
}
