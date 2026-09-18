/** §33 前端 StoryRequest 类型 —— 不要创建未来的 StoryConfig/BeatPlan/ReviewResult。 */
export interface StoryRequest {
  title: string;
  genre: string;
  premise: string;
  target_words: number;
  style?: string;
  extra_requirements?: string;
}

/** §39 Genre presets 属于 UI 便利，后端接受任意字符串。 */
export const GENRE_PRESETS = ["悬疑", "豪门", "重生", "都市", "言情", "科幻", "奇幻", "其他"] as const;

/** §40 Style presets 同样只是 UI 便利，最终发送字符串。 */
export const STYLE_PRESETS = ["节奏紧凑", "克制冷峻", "轻松幽默", "电影感", "第一人称", "第三人称"] as const;

export const TARGET_WORDS_MIN = 500;
export const TARGET_WORDS_MAX = 30000;
export const TARGET_WORDS_DEFAULT = 5000;
export const TITLE_MAX = 120;

export interface FormState {
  title: string;
  genre: string;
  customGenre: string;
  premise: string;
  targetWords: number;
  style: string;
  extraRequirements: string;
}

/** §59 纯函数：表单状态 → 发送的 JSON payload（含前端校验），便于脱离 DOM 测试。 */
export function buildRequestPayload(
  form: FormState,
): { ok: true; payload: StoryRequest } | { ok: false; error: string } {
  const title = form.title.trim();
  if (!title) return { ok: false, error: "请填写故事标题" };
  if (title.length > TITLE_MAX) return { ok: false, error: `标题不能超过 ${TITLE_MAX} 字` };

  const genre = (form.genre === "其他" ? form.customGenre : form.genre).trim();
  if (!genre) return { ok: false, error: "请选择或填写题材" };

  const premise = form.premise.trim();
  if (!premise) return { ok: false, error: "请填写故事核心设定（premise）" };

  if (!Number.isInteger(form.targetWords)) return { ok: false, error: "目标字数必须是整数" };
  if (form.targetWords < TARGET_WORDS_MIN || form.targetWords > TARGET_WORDS_MAX) {
    return { ok: false, error: `目标字数必须在 ${TARGET_WORDS_MIN} ~ ${TARGET_WORDS_MAX} 之间` };
  }

  const style = form.style.trim();
  const extra = form.extraRequirements.trim();

  return {
    ok: true,
    payload: {
      title,
      genre,
      premise,
      target_words: form.targetWords,
      ...(style ? { style } : {}),
      ...(extra ? { extra_requirements: extra } : {}),
    },
  };
}
