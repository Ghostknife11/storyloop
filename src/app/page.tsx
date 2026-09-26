"use client";

import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  BookOpen, Copy, Download, Eye, FilePlus2, FolderOpen, Loader2,
  Plus, RotateCcw, Save, Sparkles, Trash2, ArrowUp, ArrowDown, Wrench, ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { ReviewPanel } from "@/components/review-panel";
import { ValidationPanel } from "@/components/validation-panel";
import { BeatValidationPanel } from "@/components/beat-validation-panel";
import { AttemptPanel } from "@/components/attempt-panel";
import { QualityPanel } from "@/components/quality-panel";
import { CommercialPanel } from "@/components/commercial-panel";
import { ManifestPanel } from "@/components/manifest-panel";
import { TelemetryPanel } from "@/components/telemetry-panel";
import { FailurePanel } from "@/components/failure-panel";
import type { RunTelemetry } from "@/types/telemetry";
import type { FailureAnalysisResult } from "@/types/failure-analysis";
import {
  ManualRepair,
  RepairPanel,
  repairIssueLabel,
  repairStageLabels,
} from "@/components/repair-panel";
import {
  fetchRunAttempt, fetchRunFailureAnalysis, fetchRunTelemetry, generateFromPlan, planStory, previewPrompt, reviewStory, validateStory,
  reviewStoryCommercial,
  validateStoryBeats,
  RunApiError, type RepairDetailApi, type RunApiResult,
} from "@/lib/api";
import { configFilename, parseStoryConfig, serializeStoryConfig } from "@/lib/config-io";
import { attemptArtifactPath } from "@/lib/artifacts-view";
import { retryPolicyOf, useSettings } from "@/lib/settings-store";
import {
  GENRE_PRESETS, STYLE_PRESETS, STORY_CONFIG_VERSION, TARGET_WORDS_DEFAULT,
  validateStoryConfig, type StoryConfig,
} from "@/types/story-config";
import { validateBeatPlan, type BeatPlan, type StoryBeat } from "@/types/beat-plan";
import type { ReviewResult } from "@/types/review-result";
import type { ValidationResult } from "@/types/validation-result";
import type { QualityResult } from "@/types/quality";
import type { BeatValidationResult } from "@/types/beat-validation";
import type { CommercialReviewResult } from "@/types/commercial-review";

type Phase = "idle" | "generating" | "success" | "error";
type PlanPhase = "idle" | "planning" | "success" | "error";

/** §40 固定阶段（§7/§18）：UI 只能按这个顺序展示，不自行发明阶段。
 *  v0.5.0 增加 Reviewing：Story 落盘之后的审阅阶段（§35）。
 *  v0.6.0 增加 Validating：Story 落盘之后、审阅之前的硬性检查阶段（§17）。
 *  v0.8.0 的 Repairing / Revalidating / Re-reviewing（§35）只在整个 Run 真的发生过修订时
 *  才在终态补一个 Repairing 标记——没有修订的 Run 不显示这些阶段，也不伪造过程。 */
const RUN_STAGES = [
  { key: "config", label: "Preparing" },
  { key: "planning", label: "Planning" },
  { key: "generating", label: "Writing" },
  { key: "saving", label: "Saving" },
  { key: "validating", label: "Validating" },
  { key: "reviewing", label: "Reviewing" },
] as const;

type RunStageKey = (typeof RUN_STAGES)[number]["key"];
type RunStage = "idle" | RunStageKey | "completed";

interface ConfigForm {
  title: string;
  genre: string;
  customGenre: string;
  premise: string;
  setting: string;
  protagonistName: string;
  protagonistIdentity: string;
  protagonistGoal: string;
  protagonistMotivation: string;
  conflict: string;
  stakes: string;
  ending: string;
  targetWords: number;
  style: string;
  extraRequirements: string;
}

const EMPTY_FORM: ConfigForm = {
  title: "", genre: "悬疑", customGenre: "", premise: "", setting: "",
  protagonistName: "", protagonistIdentity: "", protagonistGoal: "", protagonistMotivation: "",
  conflict: "", stakes: "", ending: "", targetWords: TARGET_WORDS_DEFAULT,
  style: "", extraRequirements: "",
};

/** §69 单一序列化层：表单 ↔ StoryConfig 的唯一转换点。 */
function formToConfig(f: ConfigForm): StoryConfig {
  const genre = (f.genre === "其他" ? f.customGenre : f.genre).trim();
  const config: StoryConfig = {
    config_version: STORY_CONFIG_VERSION,
    title: f.title.trim(),
    genre,
    premise: f.premise.trim(),
    target_words: f.targetWords,
  };
  if (f.setting.trim()) config.setting = f.setting.trim();
  if (f.protagonistName.trim()) {
    config.protagonist = {
      name: f.protagonistName.trim(),
      ...(f.protagonistIdentity.trim() ? { identity: f.protagonistIdentity.trim() } : {}),
      ...(f.protagonistGoal.trim() ? { goal: f.protagonistGoal.trim() } : {}),
      ...(f.protagonistMotivation.trim() ? { motivation: f.protagonistMotivation.trim() } : {}),
    };
  }
  if (f.conflict.trim()) config.conflict = f.conflict.trim();
  if (f.stakes.trim()) config.stakes = f.stakes.trim();
  if (f.ending.trim()) config.ending = f.ending.trim();
  if (f.style.trim()) config.style = f.style.trim();
  if (f.extraRequirements.trim()) config.extra_requirements = f.extraRequirements.trim();
  return config;
}

function configToForm(c: StoryConfig): ConfigForm {
  return {
    title: c.title,
    genre: GENRE_PRESETS.includes(c.genre as never) ? c.genre : "其他",
    customGenre: GENRE_PRESETS.includes(c.genre as never) ? "" : c.genre,
    premise: c.premise,
    setting: c.setting ?? "",
    protagonistName: c.protagonist?.name ?? "",
    protagonistIdentity: c.protagonist?.identity ?? "",
    protagonistGoal: c.protagonist?.goal ?? "",
    protagonistMotivation: c.protagonist?.motivation ?? "",
    conflict: c.conflict ?? "",
    stakes: c.stakes ?? "",
    ending: c.ending ?? "",
    targetWords: c.target_words,
    style: c.style ?? "",
    extraRequirements: c.extra_requirements ?? "",
  };
}

/** §37 前端校验（§70 Save 前也用它）：必填 + 范围。 */
function validateForm(f: ConfigForm): string | null {
  if (!f.title.trim()) return "请填写故事标题";
  if (f.title.trim().length > 120) return "标题不能超过 120 字";
  const genre = (f.genre === "其他" ? f.customGenre : f.genre).trim();
  if (!genre) return "请选择或填写题材";
  if (!f.premise.trim()) return "请填写故事核心设定（premise）";
  if (!Number.isInteger(f.targetWords)) return "目标字数必须是整数";
  if (f.targetWords < 500 || f.targetWords > 30000) return "目标字数必须在 500 ~ 30000 之间";
  return null;
}

/** §22 BeatPlan 过期判定：plan 生成后，这些 StoryConfig 字段再变就算过期。 */
const PLAN_RELEVANT_KEYS: Array<keyof StoryConfig> = [
  "premise", "setting", "protagonist", "conflict", "stakes", "ending",
];

/** 只快照与 BeatPlan 相关的字段：与 plan 无关的编辑（标题/风格）不应误标记过期。 */
function planRelevantSnapshot(config: StoryConfig): string {
  return JSON.stringify(PLAN_RELEVANT_KEYS.map((k) => config[k] ?? null));
}

/** §19 增删/移动后重新编号：id 必须从 1 连续，否则 validateBeatPlan 拒绝。 */
function renumberBeats(beats: StoryBeat[]): StoryBeat[] {
  return beats.map((b, i) => ({ ...b, id: i + 1 }));
}

/** characters 输入用中文顿号/逗号分隔，落回字符串数组。 */
function parseCharacters(text: string): string[] {
  return text.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
}

export default function GeneratePage() {
  const [settings] = useSettings();
  const [form, setForm] = useState<ConfigForm>(EMPTY_FORM);
  const [baseline, setBaseline] = useState<string>(serializeStoryConfig(formToConfig(EMPTY_FORM)));
  const [beatPlan, setBeatPlan] = useState<BeatPlan | null>(null);
  const [planBaseline, setPlanBaseline] = useState<string | null>(null);
  const [planPhase, setPlanPhase] = useState<PlanPhase>("idle");
  const [planError, setPlanError] = useState("");
  // v1.4.0：Beat Validation 状态。与 StoryConfig / BeatPlan 编辑独立——
  // 骨架一改，上一次结论就作废（在 setBeatPlan 的唯一出口处清空）。
  const [beatValidation, setBeatValidation] = useState<BeatValidationResult | null>(null);
  const [beatValidationStatus, setBeatValidationStatus] = useState("not_started");
  const [beatValidationError, setBeatValidationError] = useState("");
  const [beatValidating, setBeatValidating] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<RunApiResult | null>(null);
  /** v1.8.0 §26：这次 Run 的执行遥测。读完后仍是 null 就是旧 Run（没有 telemetry.json），
   *  此时不显示面板，改为一句「Telemetry unavailable for this run」（§29）。 */
  const [telemetry, setTelemetry] = useState<RunTelemetry | null>(null);
  const [telemetryStage, setTelemetryStage] = useState<"idle" | "loading" | "loaded">("idle");
  /** v1.9.0 §31：这次 Run 的失败分类。读完后仍是 null 分两种情况——1.9.0 之前的旧 Run
   *  没有 failure-analysis.json，或者这次分析自己没跑成（metadata 里记 unavailable），
   *  此时不显示面板，改为一句「这个 Run 没有失败分析」。 */
  const [failureAnalysis, setFailureAnalysis] = useState<FailureAnalysisResult | null>(null);
  const [failureStage, setFailureStage] = useState<"idle" | "loading" | "loaded">("idle");
  const [runTitle, setRunTitle] = useState("");
  const [runStage, setRunStage] = useState<RunStage>("idle");
  const [runFailed, setRunFailed] = useState(false);
  const [failedStage, setFailedStage] = useState<string | null>(null);
  const [failedRunId, setFailedRunId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [loadText, setLoadText] = useState("");
  // §34：Review Again 只重新审阅当前正文，不重新生成 Story
  const [reReviewing, setReReviewing] = useState(false);
  const [reviewOverride, setReviewOverride] = useState<ReviewResult | null>(null);
  // v1.5.0 TASK §31：Commercial Review Again 与 Review Again 完全并列——
  // 两个按钮、两个接口、两份互不覆盖的结论，谁也不会触发对方的请求。
  const [reCommercialReviewing, setReCommercialReviewing] = useState(false);
  const [commercialReviewOverride, setCommercialReviewOverride] = useState<CommercialReviewResult | null>(null);
  const [revalidating, setRevalidating] = useState(false);
  const [validationOverride, setValidationOverride] = useState<ValidationResult | null>(null);
  // §36：默认展示 selected_attempt；点开其它 Attempt 才切过去
  const [viewAttempt, setViewAttempt] = useState<{
    number: number;
    story: string;
    validation: ValidationResult | null;
    review: ReviewResult | null;
    /** v1.5.0 TASK §17：这一次尝试的商业可读性结论，与 review 各自独立。 */
    commercial_review: CommercialReviewResult | null;
    quality: QualityResult | null;
  } | null>(null);
  // §36/§37：当前查看的 Attempt 的修订详情与修订前的正文（用于 Repair 面板与 Before / After）
  const [attemptInfo, setAttemptInfo] = useState<{
    number: number;
    initialStory: string | null;
    repairs: RepairDetailApi[];
  } | null>(null);
  // §37：Before / After 两个 Tab，默认展示修订后的版本
  const [storyTab, setStoryTab] = useState<"before" | "after">("after");
  // §38：手动修订成功后替换当前展示的正文（只改展示，不改 Run 产物）
  const [repairOverride, setRepairOverride] = useState<string | null>(null);
  const [loadingAttempt, setLoadingAttempt] = useState<number | null>(null);
  const busyRef = useRef(false);
  const planBusyRef = useRef(false);
  /** §35 同一原因：state 是异步的，双击时第二次回调看到的还是旧值，
   *  所以「正在请求」这件事必须用 ref 同步挡住，不能只靠 state。 */
  const reReviewingRef = useRef(false);
  /** v1.5.0 同 §35：商业审阅也要防连点，且与 reReviewingRef 互不影响。 */
  const reCommercialReviewingRef = useRef(false);
  const revalidatingRef = useRef(false);
  const beatValidatingRef = useRef(false);
  /** §36 快速切换 Attempt 会并发多个读回请求：用递增序号认领最后一次点击，
   *  先发出的请求后返回时直接丢弃，免得面板停在早先点开的那个 Attempt 上。 */
  const viewAttemptSeq = useRef(0);
  const stepperTimers = useRef<number[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const set = (p: Partial<ConfigForm>) => setForm(prev => ({ ...prev, ...p }));
  const isDirty = serializeStoryConfig(formToConfig(form)) !== baseline;
  const dirtyLabel = isDirty ? "Modified" : "Saved";

  /** v1.4.0：骨架一变，上一次结构校验结论就不再描述它——就地作废，
   *  免得把旧结论当成新骨架的答案摆在面板上。所有改骨架的入口都走这里。 */
  const setBeatPlanChecked = (updater: (prev: BeatPlan | null) => BeatPlan | null) => {
    setBeatPlan(updater);
    setBeatValidation(null);
    setBeatValidationStatus("not_started");
    setBeatValidationError("");
  };

  // §22：plan 生成后，plan 相关字段变化 → outdated
  const planOutdated =
    beatPlan !== null &&
    planBaseline !== null &&
    planRelevantSnapshot(formToConfig(form)) !== planBaseline;

  // §40 乐观阶段推进：服务端不推送进度，客户端只按固定顺序展示，
  // 最终状态一律以服务端返回为准（completed，或 failed + stage）。
  const clearStepperTimers = () => {
    stepperTimers.current.forEach((t) => window.clearTimeout(t));
    stepperTimers.current = [];
  };

  const beginStepper = () => {
    clearStepperTimers();
    setRunStage("config");
    // Manual Run 跳过 Planning（§29：beat_plan 由用户提供，Pipeline 不再调 Planner）
    (["generating", "saving", "validating", "reviewing"] as RunStageKey[]).forEach((stage, i) => {
      stepperTimers.current.push(window.setTimeout(() => setRunStage(stage), (i + 1) * 700));
    });
  };

  const applyConfig = (config: StoryConfig) => {
    setForm(configToForm(config));
    setBaseline(serializeStoryConfig(config));
    // 整份配置被替换：旧剧情骨架随之失效（§26 生成失败也不丢 config，但换配置要重新规划）
    setBeatPlan(null);
    setPlanBaseline(null);
    setPlanPhase("idle");
    setPlanError("");
    setBeatValidation(null);
    setBeatValidationStatus("not_started");
    setBeatValidationError("");
    setResult(null);
    setRunTitle("");
    setRunStage("idle");
    setRunFailed(false);
    setFailedStage(null);
    setFailedRunId(null);
    setPreview(null);
    setPhase("idle");
    setTelemetry(null);
    setTelemetryStage("idle");
    // v1.9.0：新的一次 Run 开始前，上一次的失败分类同样作废
    setFailureAnalysis(null);
    setFailureStage("idle");
    setReReviewing(false);
    setReviewOverride(null);
    setReCommercialReviewing(false);
    setCommercialReviewOverride(null);
    setRevalidating(false);
    setValidationOverride(null);
    setViewAttempt(null);
    setAttemptInfo(null);
    setStoryTab("after");
    setRepairOverride(null);
    setLoadingAttempt(null);
    clearStepperTimers();
  };

  // §19 BeatPlan 手动编辑：改字段 / 增删 / 移动。编辑的是 plan 本身，不是 StoryConfig，
  // 因此 planOutdated 不变（§22 只由 StoryConfig 变化触发）。
  const patchBeat = (id: number, patch: Partial<StoryBeat>) =>
    setBeatPlanChecked((prev) =>
      prev ? { ...prev, beats: prev.beats.map((b) => (b.id === id ? { ...b, ...patch } : b)) } : prev,
    );

  const addBeat = () =>
    setBeatPlanChecked((prev) => {
      if (!prev) return prev;
      const nextId = prev.beats.reduce((max, b) => Math.max(max, b.id), 0) + 1;
      return { ...prev, beats: [...prev.beats, { id: nextId, purpose: "", event: "", characters: [] }] };
    });

  const deleteBeat = (id: number) =>
    setBeatPlanChecked((prev) =>
      prev ? { ...prev, beats: renumberBeats(prev.beats.filter((b) => b.id !== id)) } : prev,
    );

  const moveBeat = (index: number, delta: number) =>
    setBeatPlanChecked((prev) => {
      if (!prev) return prev;
      const to = index + delta;
      if (to < 0 || to >= prev.beats.length) return prev;
      const beats = [...prev.beats];
      const [moved] = beats.splice(index, 1);
      beats.splice(to, 0, moved);
      return { ...prev, beats: renumberBeats(beats) };
    });

  // §29 Load：先完整解析 + 验证，全部成功才替换表单（§46 原子性）
  const loadFromText = (text: string) => {    try {
      const config = parseStoryConfig(text);
      applyConfig(config);
      setLoadOpen(false);
      setLoadText("");
      toast.success("Config 已加载");
    } catch (e) {
      // §27：失败时当前表单保持不变，给出具体原因
      toast.error(`Config load failed：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleLoadFile = (file: File) => {
    file.text().then(loadFromText).catch(() => toast.error("Config load failed：文件读取失败"));
  };

  // §28 Save：下载 sanitized_title.story.json
  const handleSave = () => {
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    const config = formToConfig(form);
    const blob = new Blob([serializeStoryConfig(config)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = configFilename(config.title);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setBaseline(serializeStoryConfig(config));
    toast.success(`Config 已保存：${configFilename(config.title)}`);
  };

  // §30 New：恢复默认值（dirty 时二次确认 §44）
  const handleNew = () => {
    if (isDirty && !window.confirm("You have unsaved changes. 确定新建配置？")) return;
    applyConfig(formToConfig(EMPTY_FORM));
    setForm(EMPTY_FORM);
    setBaseline(serializeStoryConfig(formToConfig(EMPTY_FORM)));
    toast.success("已新建配置");
  };

  // §9/§18 Generate Plan：StoryConfig → BeatPlanner → BeatPlan
  async function handlePlan() {
    if (planBusyRef.current) return;
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    planBusyRef.current = true;
    setPlanPhase("planning");
    setPlanError("");
    try {
      const config = formToConfig(form);
      const plan = await planStory(config, {
        model: settings.model || undefined,
        baseUrl: settings.baseUrl || undefined,
        temperature: settings.temperature,
      });
      setBeatPlan(plan);
      setPlanBaseline(planRelevantSnapshot(config));
      // 新骨架上一份结论还没跑过：面板处于「尚未校验」，而不是继续显示上一份的结论
      setBeatValidation(null);
      setBeatValidationStatus("not_started");
      setBeatValidationError("");
      setPlanPhase("success");
      toast.success(`剧情骨架已生成：${plan.beats.length} 个 Beat`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "未知错误";
      setPlanError(msg);
      setPlanPhase("error");
      toast.error(msg);
    } finally {
      planBusyRef.current = false;
    }
  }

  async function handleGenerate() {
    if (busyRef.current) return;
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    if (!beatPlan) { toast.error("Generate a beat plan first."); return; }
    // §47 手动编辑可能留下空字段：先本地校验，避免无谓请求
    try {
      validateBeatPlan(beatPlan);
    } catch (e) {
      toast.error(`BeatPlan 不合法：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (planOutdated && !window.confirm(
      "StoryConfig changed after this plan was generated.\n确定使用现有 BeatPlan 生成？（Use Existing Plan Anyway）",
    )) return;
    busyRef.current = true;
    const title = formToConfig(form).title;
    setPhase("generating");
    setErrorMsg("");
    setPreview(null);
    setFailedStage(null);
    setFailedRunId(null);
    setRunFailed(false);
    setReReviewing(false);
    setReviewOverride(null);
    setReCommercialReviewing(false);
    setCommercialReviewOverride(null);
    setRevalidating(false);
    setValidationOverride(null);
    setBeatValidating(false);
    setBeatValidation(null);
    setBeatValidationStatus("not_started");
    setBeatValidationError("");
    setViewAttempt(null);
    setLoadingAttempt(null);
    setAttemptInfo(null);
    setStoryTab("after");
    setRepairOverride(null);
    beginStepper();
    try {
      const config = formToConfig(form);
      const data = await generateFromPlan(config, beatPlan, {
        model: settings.model || undefined,
        baseUrl: settings.baseUrl || undefined,
        temperature: settings.temperature,
      }, retryPolicyOf(settings));
      clearStepperTimers();
      setResult(data);
      setRunTitle(title);
      setRunStage("completed");
      setPhase("success");
      // v1.4.0：这次 Run 用到的就是当前这份骨架，它的结构校验结论直接落到面板上
      setBeatValidation(data.beat_validation);
      setBeatValidationStatus(data.beat_validation_status);
      setBeatValidationError("");
      // §16/§34：把重试结论直接讲清楚，不让用户猜为什么换了正文
      toast.success(
        data.quality_status === "accepted"
          ? `Run 完成：${data.run_id} · Attempt ${data.selected_attempt} 已采纳`
          : `Run 完成：${data.run_id} · 尝试次数已用尽，展示 Attempt ${data.selected_attempt}`,
      );
      // §36：发生过修订时补一次请求，拿修订详情与修订前的正文（没有修订就不额外请求）
      void loadAttemptInfo(data, data.selected_attempt);
      // v1.8.0 §25：遥测单独读一次。POST 响应里没有它——响应契约保持不变（§45），
      // 而遥测在 Run 结束时已经落盘，所以这一次请求一定能读到 1.8.0 起的 Run。
      setTelemetryStage("loading");
      void fetchRunTelemetry(data.run_id)
        .then((t) => {
          setTelemetry(t);
          setTelemetryStage("loaded");
        })
        .catch(() => {
          // 遥测读不到不影响正文与任何结论：只当这次没有可观测数据
          setTelemetry(null);
          setTelemetryStage("loaded");
        });
      // v1.9.0 §31：失败分类同样单独读一次（与遥测同一套理由：POST 响应契约不变）。
      // 分析在 Run 收尾时已经落盘，所以这次请求一定能读到 1.9.0 起的 Run。
      setFailureStage("loading");
      void fetchRunFailureAnalysis(data.run_id)
        .then((a) => {
          setFailureAnalysis(a);
          setFailureStage("loaded");
        })
        .catch(() => {
          // 读不到失败分类不影响任何结论：只当这次没有这份分析
          setFailureAnalysis(null);
          setFailureStage("loaded");
        });
    } catch (e) {
      clearStepperTimers();
      const msg = e instanceof Error ? e.message : "未知错误";
      if (e instanceof RunApiError) {
        setFailedStage(e.stage ?? null);
        setFailedRunId(e.runId ?? null);
      }
      setErrorMsg(msg);
      setRunFailed(true);
      setPhase("error");
      toast.error(msg);
      // v1.8.0 §15：失败的 Run 也落 telemetry.json，失败阶段同样要能看见。
      // 没有 run_id（还没开始建产物就失败了）时无从读起，保持 idle。
      if (e instanceof RunApiError && e.runId) {
        const failedId = e.runId;
        setTelemetryStage("loading");
        void fetchRunTelemetry(failedId)
          .then((t) => {
            setTelemetry(t);
            setTelemetryStage("loaded");
          })
          .catch(() => {
            setTelemetry(null);
            setTelemetryStage("loaded");
          });
        // v1.9.0 §27：失败的 Run 也有失败分析——它正是最需要分类的那一次
        setFailureStage("loading");
        void fetchRunFailureAnalysis(failedId)
          .then((a) => {
            setFailureAnalysis(a);
            setFailureStage("loaded");
          })
          .catch(() => {
            setFailureAnalysis(null);
            setFailureStage("loaded");
          });
      }
    } finally {
      busyRef.current = false;
    }
  }

  async function handlePreview() {
    if (previewing) return;
    const err = validateForm(form);
    if (err) { toast.error(err); return; }
    setPreviewing(true);
    try {
      setPreview(await previewPrompt(formToConfig(form), beatPlan ?? undefined));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "预览失败");
    } finally {
      setPreviewing(false);
    }
  }

  // §29/§50 Review Again：只对当前正文重新审阅，绝不重新生成 Story。
  async function handleReviewAgain() {
    if (reReviewingRef.current || !result) return;
    reReviewingRef.current = true;
    setReReviewing(true);
    try {
      const review = await reviewStory(
        formToConfig(form),
        baseStory,
        {
          model: settings.model || undefined,
          baseUrl: settings.baseUrl || undefined,
          temperature: settings.temperature,
        },
        // §30：只有当前展示的正是 Run 落盘的那一版，才覆盖 run 目录里的 review.json；
        // 看别的 Attempt 或手动修订后的版本时只重新审阅，不动磁盘上的结论。
        shownStoryIsRunStory ? result.run_id : undefined,
      );
      // §30：服务端已覆盖该 Run 的 review.json，前端同步展示最新评价
      setReviewOverride(review);
      toast.success(`Review 完成：${review.score} / 100`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "审阅失败");
    } finally {
      reReviewingRef.current = false;
      setReReviewing(false);
    }
  }

  // v1.5.0 TASK §27 Commercial Review Again：只对当前正文重跑四个商业维度。
  // 走独立的 /api/review/commercial，不重新生成 Story，也不触碰结构审阅的 review.json。
  async function handleCommercialReviewAgain() {
    if (reCommercialReviewingRef.current || !result) return;
    reCommercialReviewingRef.current = true;
    setReCommercialReviewing(true);
    try {
      const review = await reviewStoryCommercial(
        formToConfig(form),
        baseStory,
        {
          model: settings.model || undefined,
          baseUrl: settings.baseUrl || undefined,
          temperature: settings.temperature,
        },
        // §30：与 Review Again 同一条边界——只有当前展示的正是 Run 落盘的那一版
        // 才覆盖 run 目录里的 commercial-review.json。
        shownStoryIsRunStory ? result.run_id : undefined,
      );
      setCommercialReviewOverride(review);
      toast.success(`Commercial Review 完成：${review.score} / 100`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "商业审阅失败");
    } finally {
      reCommercialReviewingRef.current = false;
      setReCommercialReviewing(false);
    }
  }

  // §27 Validate Again：只对当前正文重新跑硬性规则，绝不重新生成 Story，也不调用 Reviewer。
  async function handleValidateAgain() {
    if (revalidatingRef.current || !result) return;
    revalidatingRef.current = true;
    setRevalidating(true);
    try {
      const validation = await validateStory(
        formToConfig(form),
        baseStory,
        // 同 Review Again：非 Run 落盘的那一版只重新校验，不覆盖 validation.json
        shownStoryIsRunStory ? result.run_id : undefined,
      );
      // §27：服务端已覆盖该 Run 的 validation.json，前端同步展示最新校验结果
      setValidationOverride(validation);
      toast.success(validation.passed ? "Validation：Passed" : "Validation：Failed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "校验失败");
    } finally {
      revalidatingRef.current = false;
      setRevalidating(false);
    }
  }

  // v1.4.0 Validate Beats：只重新检查当前剧情骨架，不生成正文、不改写骨架。
  // 与 Generate 时 Pipeline 内部那一次校验同一个服务端实现，结论口径一致。
  async function handleValidateBeats() {
    if (beatValidatingRef.current) return;
    if (!beatPlan) { toast.error("Generate a beat plan first."); return; }
    // §47 手动编辑可能留下空字段：先本地校验，避免无谓请求
    try {
      validateBeatPlan(beatPlan);
    } catch (e) {
      toast.error(`BeatPlan 不合法：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    beatValidatingRef.current = true;
    setBeatValidating(true);
    setBeatValidationError("");
    try {
      const result = await validateStoryBeats(formToConfig(form), beatPlan);
      setBeatValidation(result);
      setBeatValidationStatus("completed");
      toast.success(result.passed
        ? "Beat Validation：Passed"
        : `Beat Validation：Not Passed（${result.issues.length} issues）`);
    } catch (e) {
      setBeatValidation(null);
      setBeatValidationStatus("failed");
      const msg = e instanceof Error ? e.message : "未知错误";
      setBeatValidationError(msg);
      toast.error(msg);
    } finally {
      beatValidatingRef.current = false;
      setBeatValidating(false);
    }
  }

  // §37：复制 / 下载的必须是当前展示的那一版正文（可能是某次 Attempt 或手动修订后的版本），
  // 而不是永远导出入选 Attempt 的正文。
  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(`# ${runTitle}\n\n${shownStory}`).then(() => toast.success("Copied"));
  };

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([`# ${runTitle}\n\n${shownStory}`], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${runTitle.replace(/[\\/:*?"<>|]/g, "_")}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  /** §36/§37 读取某一次 Attempt 的修订详情（问题说明、前后分数、修订前的正文）。
   *  只在这个 Attempt 真的发生过修订时调用——没有修订的 Attempt 不值得多一次请求。 */
  async function loadAttemptInfo(run: RunApiResult, attemptNumber: number) {
    const summary = run.attempts.find((a) => a.attempt_number === attemptNumber);
    if (!summary || summary.repair_count === 0) {
      setAttemptInfo(null);
      setStoryTab("after");
      return;
    }
    try {
      const detail = await fetchRunAttempt(run.run_id, attemptNumber);
      setAttemptInfo({
        number: attemptNumber,
        initialStory: detail.initial_story,
        repairs: detail.repairs,
      });
      setStoryTab("after");
    } catch (e) {
      // §35：修订详情读不到不影响正文与结论的展示
      toast.error(e instanceof Error ? e.message : "读取修订详情失败");
      setAttemptInfo(null);
    }
  }

  /** §35/§36 查看某一次 Attempt：按需拉取该 Attempt 的正文与结论，不做横向比较。 */
  async function handleViewAttempt(attemptNumber: number) {
    if (!result) return;
    // 点回被选中的 Attempt：直接回到 RunOk 里的最终结果，不再请求一次
    if (attemptNumber === result.selected_attempt) {
      viewAttemptSeq.current += 1;
      setViewAttempt(null);
      setLoadingAttempt(null);
      void loadAttemptInfo(result, attemptNumber);
      return;
    }
    setLoadingAttempt(attemptNumber);
    const seq = (viewAttemptSeq.current += 1);
    try {
      const detail = await fetchRunAttempt(result.run_id, attemptNumber);
      // §36：这期间又点了别的 Attempt，这次响应就过期了
      if (seq !== viewAttemptSeq.current) return;
      setViewAttempt({
        number: attemptNumber,
        story: detail.story,
        validation: detail.validation,
        review: detail.review,
        commercial_review: detail.commercial_review,
        quality: detail.quality,
      });
      setAttemptInfo({
        number: attemptNumber,
        initialStory: detail.initial_story,
        repairs: detail.repairs,
      });
      setStoryTab("after");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "读取 Attempt 失败");
    } finally {
      setLoadingAttempt(null);
    }
  }

  /** §37：看修订前还是修订后的正文；没有 initial_story 时只有 After 一个 Tab。 */
  const baseStory = viewAttempt
    ? viewAttempt.story
    : repairOverride ?? result?.story ?? "";
  const showBefore =
    storyTab === "before" && attemptInfo?.initialStory !== null && attemptInfo !== null;
  const shownStory = showBefore ? (attemptInfo?.initialStory ?? "") : baseStory;
  const shownValidation = viewAttempt ? viewAttempt.validation : validationOverride ?? result?.validation ?? null;
  const shownValidationStatus = viewAttempt
    ? (viewAttempt.validation ? "completed" : "not_started")
    : validationOverride ? "completed" : result?.validation_status ?? "not_started";
  const shownReview = viewAttempt ? viewAttempt.review : reviewOverride ?? result?.review ?? null;
  const shownReviewStatus = viewAttempt
    ? (viewAttempt.review ? "completed" : "not_started")
    : reviewOverride ? "completed" : result?.review_status ?? "not_started";
  /** v1.5.0 TASK §27：商业结论跟着当前看的 Attempt 切，与 shownReview 同一套规则，
   *  但两者互不影响——重审阅结构不会顶掉商业分，反过来也一样。 */
  const shownCommercialReview = viewAttempt
    ? viewAttempt.commercial_review
    : commercialReviewOverride ?? result?.commercial_review ?? null;
  const shownCommercialReviewStatus = viewAttempt
    ? (viewAttempt.commercial_review ? "completed" : "not_started")
    : commercialReviewOverride ? "completed" : result?.commercial_review_status ?? "not_started";
  /** v1.2.0 §26：同样跟着当前看的 Attempt 切；手动审阅/校验不影响质量快照（§36 只改正文与结论）。 */
  const shownQuality = viewAttempt ? viewAttempt.quality : result?.quality ?? null;
  /** §36：当前看的是哪一次 Attempt。 */
  const viewingAttempt = viewAttempt?.number ?? result?.selected_attempt ?? 0;
  /** §36/§30：当前展示的正是 Run 落盘的那一版（入选 Attempt、没有手动修订）时为 true。
   *  只有这时 Review Again / Validate Again 才覆盖 run 目录里的结论。 */
  const shownStoryIsRunStory = !viewAttempt && !repairOverride;
  /** §36：当前 Attempt 的修订记录（只有真的修过才有内容）。 */
  const shownRepairs = attemptInfo?.repairs ?? [];
  /** §37：只有「当前看的这次 Attempt 修过」才给 Before / After 两个 Tab。 */
  const hasBeforeStory = attemptInfo !== null && attemptInfo.initialStory !== null;

  const handleDownloadConfig = () => {
    const blob = new Blob([serializeStoryConfig(formToConfig(form))], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = configFilename(formToConfig(form).title);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const fieldCls = "h-9";
  const generating = phase === "generating";
  const planning = planPhase === "planning";
  const busy = generating || planning;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-auto p-3 sm:p-4 gap-3">
      {/* §24 Step 1/2 — StoryConfig → Step 2/2 — Beats & Story（纯前端表现） */}
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
        <span className={planPhase === "success" ? "text-emerald-500" : ""}>Step 1 / 2 — StoryConfig</span>
        <span>→</span>
        <span className={planPhase === "success" ? "" : "opacity-40"}>Step 2 / 2 — Beats &amp; Story</span>
        {beatPlan && planOutdated && (
          <span className="ml-auto text-amber-500 border border-amber-500/30 bg-amber-500/10 rounded-full px-2.5 py-0.5">
            BeatPlan Outdated — StoryConfig changed. Regenerate the plan before generating the story.
          </span>
        )}
      </div>

      {/* §40 Run 进度：固定四阶段（§7），Planning 在手动模式下跳过（§29）。
          服务端不推送进度，这里的推进是乐观的；终态一律以服务端返回为准。 */}
      {runStage !== "idle" && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
          {RUN_STAGES.map((s, i) => {
            const isPlanning = s.key === "planning";
            const currentIndex = RUN_STAGES.findIndex((x) => x.key === runStage);
            const failed = runFailed && (s.key === failedStage || (!failedStage && currentIndex === i));
            const active = !failed && !isPlanning && !runFailed && runStage !== "completed" && currentIndex === i;
            const done = !failed && !isPlanning && (runStage === "completed" || (currentIndex >= 0 && i < currentIndex));
            const skipped = !failed && !active && !done && isPlanning;
            const tone = failed
              ? "text-red-500 border-red-500/30 bg-red-500/10"
              : done
                ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
                : active
                  ? "text-violet-600 dark:text-violet-300 border-violet-500/40 bg-violet-500/10"
                  : skipped
                    ? "text-muted-foreground/60 border-border"
                    : "text-muted-foreground border-border";
            return (
              <span key={s.key} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${tone}`}>
                {failed ? "✕" : done ? "✓" : active ? <Loader2 className="h-3 w-3 animate-spin" /> : skipped ? "–" : "·"}
                {s.label}
                {skipped && <span className="opacity-70">skipped</span>}
              </span>
            );
          })}
          {runStage === "completed" && result && (
            <span className="ml-auto text-emerald-500">Run {result.run_id} · {result.status}</span>
          )}
        </div>
      )}

      {/* §33 重试提示：服务端不推送进度，这里只说明可能发生的自动重试，
          真实结果一律以 Attempt 面板为准（不伪造 Attempt 1 → Retrying → Attempt 2 的过程）。 */}
      {generating && settings.retryEnabled && settings.maxAttempts > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
          <RotateCcw className="h-3 w-3 text-violet-600 dark:text-violet-400" />
          <span>
            Automatic Retry on：校验未通过或审阅分数低于 {settings.minReviewScore} 时会重新生成整篇
            （最多 {settings.maxAttempts} 次，会增加 API 调用与费用）。
          </span>
        </div>
      )}

      {/* §20/§35 修订提示：说明 Repair-before-Retry，但不在终态伪造修订过程。 */}
      {generating && settings.repairEnabled && settings.maxRepairsPerAttempt > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
          <Wrench className="h-3 w-3 text-violet-600 dark:text-violet-400" />
          <span>
            Targeted Repair on：未通过时先针对单个问题修订现有正文，再重新校验 / 审阅
            （每次生成最多 {settings.maxRepairsPerAttempt} 次）。
          </span>
        </div>
      )}

      {/* §35：整个 Run 真的发生过修订时，在终态补一个 Repairing 标记（不伪造分步过程）。 */}
      {runStage === "completed" && result && result.repair_count > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
          {repairStageLabels(result.repair_count).map((label) => (
            <span
              key={label}
              className={`flex items-center gap-1 rounded-full border px-2 py-0.5 ${
                label === "Repairing"
                  ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300"
                  : "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
              }`}
            >
              ✓ {label}
            </span>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 flex-1 min-h-0">
        {/* 配置区 */}
        <section className="flex flex-col rounded-3xl border border-border bg-card/60 glass shadow-soft p-4 sm:p-5 gap-4 min-h-0 overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-violet-500 shadow-glow" />
              <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">Story Config</h2>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${isDirty ? "text-amber-500 border-amber-500/30 bg-amber-500/10" : "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"}`}>
                {dirtyLabel}
              </span>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleNew} title="New Config">
                <FilePlus2 className="h-3.5 w-3.5" /> New
              </Button>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={() => fileRef.current?.click()} title="Load Config（.json）">
                <FolderOpen className="h-3.5 w-3.5" /> Load
              </Button>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleSave} title="Save Config">
                <Save className="h-3.5 w-3.5" /> Save
              </Button>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleLoadFile(f); e.target.value = ""; }} />
            </div>
          </div>

          {/* §41 Basic */}
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Story Title</Label>
              <Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="消失的目击者" maxLength={120} disabled={busy} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Target Words</Label>
              <Input type="number" min={500} max={30000} step={100} value={form.targetWords}
                onChange={(e) => set({ targetWords: Number(e.target.value) })} disabled={busy} className={fieldCls} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Genre</Label>
              <select value={form.genre} onChange={(e) => set({ genre: e.target.value })} disabled={busy}
                className="w-full h-9 rounded-lg border border-input bg-transparent px-3 text-xs text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30">
                {GENRE_PRESETS.map((g) => <option key={g} value={g} className="bg-card">{g}</option>)}
              </select>
            </div>
            {form.genre === "其他" && (
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">自定义题材</Label>
                <Input value={form.customGenre} onChange={(e) => set({ customGenre: e.target.value })} placeholder="黑色幽默荒诞职场" disabled={busy} className={fieldCls} />
              </div>
            )}
          </div>

          {/* §41 Core Story */}
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
            <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">Core Story</span>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Premise（核心设定）</Label>
              <Textarea value={form.premise} onChange={(e) => set({ premise: e.target.value })}
                placeholder="一名商业贿赂案的唯一证人在出庭前一天突然失踪，负责保护她的警员只离开了三分钟。"
                disabled={busy} className="min-h-[64px] resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Setting（故事背景，可选）</Label>
              <Input value={form.setting} onChange={(e) => set({ setting: e.target.value })}
                placeholder="现代一线城市，商业贿赂案庭审前夜。" disabled={busy} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Conflict（主要冲突，可选）</Label>
              <Input value={form.conflict} onChange={(e) => set({ conflict: e.target.value })}
                placeholder="女主必须在嫌疑人销毁证据之前找到失踪证人。" disabled={busy} className={fieldCls} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Stakes（失败代价，可选）</Label>
                <Input value={form.stakes} onChange={(e) => set({ stakes: e.target.value })}
                  placeholder="证人缺席将导致案件失败。" disabled={busy} className={fieldCls} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Ending（结局方向，可选）</Label>
                <Input value={form.ending} onChange={(e) => set({ ending: e.target.value })}
                  placeholder="留空由模型决定" disabled={busy} className={fieldCls} />
              </div>
            </div>
          </div>

          {/* §41 Protagonist */}
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
            <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">Protagonist</span>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Name</Label>
                <Input value={form.protagonistName} onChange={(e) => set({ protagonistName: e.target.value })}
                  placeholder="陈岚" disabled={busy} className={fieldCls} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-[11px] text-muted-foreground">Identity（可选）</Label>
                <Input value={form.protagonistIdentity} onChange={(e) => set({ protagonistIdentity: e.target.value })}
                  placeholder="刑警" disabled={busy} className={fieldCls} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Goal（可选）</Label>
              <Input value={form.protagonistGoal} onChange={(e) => set({ protagonistGoal: e.target.value })}
                placeholder="在开庭前找到证人" disabled={busy} className={fieldCls} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Motivation（可选）</Label>
              <Input value={form.protagonistMotivation} onChange={(e) => set({ protagonistMotivation: e.target.value })}
                placeholder="她负责证人的保护工作" disabled={busy} className={fieldCls} />
            </div>
          </div>

          {/* §41 Style */}
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
            <span className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground">Style</span>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Style（可选）</Label>
              <Input value={form.style} onChange={(e) => set({ style: e.target.value })} placeholder="冷峻、节奏紧凑"
                list="style-presets" disabled={busy} className={fieldCls} />
              <datalist id="style-presets">
                {STYLE_PRESETS.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] text-muted-foreground">Extra Requirements（可选）</Label>
              <Textarea value={form.extraRequirements} onChange={(e) => set({ extraRequirements: e.target.value })}
                placeholder={"不要使用超自然元素。\n结尾需要完整解释失踪原因。"} disabled={busy} className="min-h-[56px] resize-none" />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handlePlan} disabled={busy}
              className="flex-1 h-10 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-medium shadow-glow disabled:opacity-60">
              {planning ? <><Loader2 className="h-4 w-4 animate-spin" /> Planning...</> : <><Sparkles className="h-4 w-4" /> Generate Plan</>}
            </Button>
            <Button variant="outline" disabled={busy || previewing} onClick={handlePreview}
              className="h-10 rounded-full text-xs" title="预览渲染后的最终 Prompt（不调用 LLM）">
              {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />} Preview
            </Button>
          </div>
          {planPhase === "error" && (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-3 text-xs">
              <span className="font-medium text-red-500">Planning failed.</span>
              <span className="text-muted-foreground ml-1">{planError}</span>
              <span className="text-muted-foreground ml-1">（StoryConfig 已保留，可再次点击 Generate Plan 手动重试）</span>
            </div>
          )}
        </section>

        {/* Beat Plan + 结果区 */}
        <section className="flex flex-col gap-3 min-h-0 overflow-y-auto">
          {/* §17 Beat Plan 区 */}
          <div className="rounded-3xl border border-border bg-card/60 glass shadow-soft flex flex-col min-h-[200px] shrink-0 overflow-hidden">
            <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${beatPlan ? "bg-emerald-500" : "bg-muted-foreground"}`} />
                <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">
                  Beat Plan {beatPlan ? `(${beatPlan.beats.length})` : ""}
                </h2>
                {beatPlan && planOutdated && <span className="text-[10px] text-amber-500 font-mono">OUTDATED</span>}
              </div>
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={addBeat}
                disabled={!beatPlan || busy} title={beatPlan ? "在末尾追加一个 Beat" : "Generate a beat plan first."}>
                <Plus className="h-3.5 w-3.5" /> Add Beat
              </Button>
              {/* v1.4.0：手动检查当前骨架的结构；只报告，不顺手改写任何一拍 */}
              <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleValidateBeats}
                disabled={!beatPlan || busy || beatValidating}
                title={beatPlan ? "只检查剧情骨架的结构，不生成正文" : "Generate a beat plan first."}>
                {beatValidating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Validate Beats
              </Button>
            </div>
            <ScrollArea className="max-h-[340px]">
              <div className="p-3 sm:p-4 space-y-2">
                {!beatPlan && !planning && (
                  <div className="py-10 text-center text-muted-foreground text-[13px]">
                    点击 Generate Plan 生成剧情骨架（可查看，然后再生成正文）
                  </div>
                )}
                {planning && (
                  <div className="py-10 flex flex-col items-center gap-3 text-muted-foreground">
                    <Loader2 className="h-6 w-6 animate-spin text-violet-600 dark:text-violet-400" />
                    <span className="text-xs font-mono">Planning beats...</span>
                  </div>
                )}
                {beatPlan && (
                  <div className="space-y-1.5">
                    <Label className="text-[11px] text-muted-foreground">Summary（可选）</Label>
                    <Input value={beatPlan.summary ?? ""} placeholder="故事整体规划摘要"
                      onChange={(e) => setBeatPlanChecked((prev) => (prev ? { ...prev, summary: e.target.value || undefined } : prev))}
                      disabled={busy} className={fieldCls} />
                  </div>
                )}
                {beatPlan?.beats.map((beat, index) => (
                  <div key={beat.id} className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono font-bold text-violet-600 dark:text-violet-300">Beat {beat.id}</span>
                      <div className="ml-auto flex items-center gap-1">
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-full" title="上移"
                          disabled={busy || index === 0} onClick={() => moveBeat(index, -1)}>
                          <ArrowUp className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-full" title="下移"
                          disabled={busy || index === beatPlan.beats.length - 1} onClick={() => moveBeat(index, 1)}>
                          <ArrowDown className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 rounded-full text-red-600 dark:text-red-400 hover:text-red-600 dark:text-red-300" title="删除这个 Beat"
                          disabled={busy || beatPlan.beats.length <= 1} onClick={() => deleteBeat(beat.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-muted-foreground">Purpose</Label>
                      <Input value={beat.purpose} placeholder="这一拍的结构作用，如：建立危机"
                        onChange={(e) => patchBeat(beat.id, { purpose: e.target.value })} disabled={busy} className={fieldCls} />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-muted-foreground">Event</Label>
                      <Textarea value={beat.event} placeholder="这一拍实际发生的事件"
                        onChange={(e) => patchBeat(beat.id, { event: e.target.value })} disabled={busy} className="min-h-[56px] resize-none" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-muted-foreground">Characters（顿号分隔）</Label>
                        <Input value={beat.characters.join("、")} placeholder="陈岚、周衡"
                          onChange={(e) => patchBeat(beat.id, { characters: parseCharacters(e.target.value) })} disabled={busy} className={fieldCls} />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-[11px] text-muted-foreground">Conflict（可选）</Label>
                        <Input value={beat.conflict ?? ""} placeholder="本拍局部冲突"
                          onChange={(e) => patchBeat(beat.id, { conflict: e.target.value || undefined })} disabled={busy} className={fieldCls} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] text-muted-foreground">Expected Outcome（可选）</Label>
                      <Input value={beat.expected_outcome ?? ""} placeholder="本拍结束后故事状态的变化"
                        onChange={(e) => patchBeat(beat.id, { expected_outcome: e.target.value || undefined })} disabled={busy} className={fieldCls} />
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
            {/* v1.4.0：骨架结构校验结论。放在滚动区外面——不改骨架就不会被滚走。 */}
            {beatPlan && (
              <div className="px-3 sm:px-4 pb-3 sm:pb-4">
                <BeatValidationPanel
                  beatValidation={beatValidation}
                  beatValidationStatus={beatValidating ? "validating" : beatValidationStatus}
                  beatValidationError={beatValidationError || undefined}
                  validating={beatValidating}
                  disabled={busy}
                  onValidateAgain={handleValidateBeats}
                />
              </div>
            )}
          </div>

          {/* 生成结果 */}
          <div className="grow shrink-0 flex flex-col rounded-3xl border border-border bg-card/60 glass shadow-soft overflow-hidden">
            <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
                <h2 className="text-xs sm:text-[13px] font-semibold tracking-tight">Generated Story</h2>
              </div>
              {phase === "success" && result && (
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleCopy}>
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleDownload}>
                    <Download className="h-3.5 w-3.5" /> Markdown
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 rounded-full text-xs" onClick={handleDownloadConfig}>
                    <Download className="h-3.5 w-3.5" /> Config
                  </Button>
                </div>
              )}
            </div>

            {phase === "error" && (
              <div className="m-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-4 text-sm">
                <div className="font-medium text-red-500">Run failed.</div>
                {(failedRunId || failedStage) && (
                  <div className="text-[11px] font-mono text-muted-foreground mt-1">
                    {failedRunId ? `Run ${failedRunId}` : "Run"}
                    {failedStage ? ` · stage: ${failedStage}` : ""}
                  </div>
                )}
                <div className="text-muted-foreground mt-1 text-xs break-all">{errorMsg}</div>
                <div className="text-[11px] text-muted-foreground mt-1">BeatPlan 已保留，可直接再次点击 Generate Story。</div>
                {/* v1.8.0 §26：失败 Run 的遥测（失败阶段 + 已经跑过的阶段与调用）。
                    读不到时也不占位——没有遥测就不展示可观测面板（§29）。 */}
                <div className="mt-3">
                  <TelemetryPanel telemetry={telemetry} />
                </div>
                {/* v1.9.0 §27：失败的 Run 同样有失败分类——类别、阶段与证据。
                    读不到时不占位（§30）。 */}
                <div className="mt-3">
                  <FailurePanel analysis={failureAnalysis} />
                </div>
              </div>
            )}

            {preview && (
              <details className="mx-4 mt-3 rounded-2xl border border-violet-500/20 bg-violet-500/5 p-3" open>
                <summary className="text-[11px] font-mono tracking-wide text-violet-600 dark:text-violet-300 cursor-pointer">FINAL PROMPT（preview）</summary>
                <pre className="mt-2 text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap max-h-52 overflow-auto">{preview}</pre>
              </details>
            )}

            <div className="flex flex-col min-h-[280px]">
              {generating ? (
                <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground min-h-[280px]">
                  <Loader2 className="h-7 w-7 animate-spin text-violet-600 dark:text-violet-400" />
                  <span className="text-xs font-mono tracking-wide">Generating...</span>
                </div>
              ) : phase === "success" && result ? (
                <ScrollArea>
                  <div className="p-4 sm:p-6">
                    <h1 className="text-2xl font-bold tracking-tight mb-1">{runTitle}</h1>
                    <div className="text-[11px] text-muted-foreground font-mono mb-4">
                      Run {result.run_id} · {result.status} · {result.beat_plan.beats.length} beats
                    </div>
                    {/* §34/§35 Attempt 面板：计数 / 选中 Attempt / 质量结论 / 每次 Attempt 摘要。
                        §36 默认展示 selected_attempt——正文区读的就是被选中那一次。 */}
                    <div className="mb-4">
                      <AttemptPanel
                        attempts={result.attempts}
                        selectedAttempt={result.selected_attempt}
                        qualityStatus={result.quality_status}
                        viewingAttempt={viewingAttempt}
                        onViewAttempt={handleViewAttempt}
                        loadingAttempt={loadingAttempt}
                      />
                    </div>
                    {/* §36 Repair 结果：Type / Reason / Before Score / After Score / Validation 变化 */}
                    <RepairPanel repairs={shownRepairs} />
                    {/* §38 手动定点修订：选一个 Issue Type、写清问题，针对当前正文修一次 */}
                    <ManualRepair
                      config={formToConfig(form)}
                      plan={result.beat_plan}
                      story={baseStory}
                      validation={shownValidation}
                      review={shownReview}
                      runtime={{
                        model: settings.model || undefined,
                        baseUrl: settings.baseUrl || undefined,
                        temperature: settings.temperature,
                      }}
                      onRepaired={(story) => {
                        setRepairOverride(story);
                        setStoryTab("after");
                      }}
                    />
                    {/* v1.2.0 §31/§32 Quality Summary：总览在前，Validation / Review 作为详情在后 */}
                    <QualityPanel quality={shownQuality} />
                    {/* §28 Validation 区域：Passed / Failed + Issues（Code / Severity / Message）。
                        §29 与 Review 分开：这里只有硬性检查，没有分数。 */}
                    <ValidationPanel
                      validation={shownValidation}
                      validationStatus={shownValidationStatus}
                      validationError={result.validation_error}
                      revalidating={revalidating}
                      disabled={!baseStory}
                      onValidateAgain={handleValidateAgain}
                    />
                    {/* §31 Review 区域：Score / Summary / Strengths / Problems。
                        §34 Review 失败时正文继续显示，只把本面板切成失败态。 */}
                    <ReviewPanel
                      review={shownReview}
                      reviewStatus={shownReviewStatus}
                      reviewError={result.review_error}
                      reReviewing={reReviewing}
                      disabled={!baseStory}
                      onReviewAgain={handleReviewAgain}
                    />
                    {/* v1.5.0 TASK §27 商业可读性面板：与 Review 完全并列的第二份结论。
                        §29 只描述可读性，不做市场化预言；分数只来自四维均分。 */}
                    <CommercialPanel
                      commercialReview={shownCommercialReview}
                      commercialReviewStatus={shownCommercialReviewStatus}
                      commercialReviewError={result.commercial_review_error}
                      reReviewing={reCommercialReviewing}
                      disabled={!baseStory}
                      onReviewAgain={handleCommercialReviewAgain}
                    />
                    {/* §42 产物清单：只展示文件名，不展示服务端绝对路径（§67） */}
                    <div className="mb-4 rounded-lg border border-border bg-muted/40 p-3">
                      <div className="text-[10px] font-mono tracking-widest uppercase text-muted-foreground mb-1.5">Artifacts</div>
                      <div className="text-[11px] font-mono text-foreground">runs/{result.run_id}/</div>
                      <ul className="mt-1 space-y-0.5">
                        {Object.entries(result.artifacts).map(([key, file]) => (
                          <li key={key} className="text-[11px] font-mono text-muted-foreground">
                            {key} → {attemptArtifactPath(key, file, viewingAttempt, result.selected_attempt)}
                          </li>
                        ))}
                      </ul>
                    </div>
                    {/* v1.6.0 出身面板：这次 Run 的版本 / 模型 / 提示词 / 参数 / Attempt 事实。
                        §37 旧 Run 没有 run-manifest.json 时整个面板不出现。 */}
                    <ManifestPanel manifest={result.manifest} />
                    {/* v1.8.0 §26 Observability 面板：总量 / 阶段时间线 / LLM 调用 / 失败阶段。
                        §29 读完了却一份遥测都没有（1.8.0 之前生成的 Run）时给一句说明，
                        不补零、不猜数。 */}
                    {telemetryStage === "loaded" && telemetry === null ? (
                      <div className="mb-4 rounded-2xl border border-border bg-muted/40 p-3 text-[11px] text-muted-foreground">
                        Telemetry unavailable for this run —— 这次 Run 没有 telemetry.json（1.8.0 之前的产物）。
                      </div>
                    ) : (
                      <TelemetryPanel telemetry={telemetry} />
                    )}
                    {/* v1.9.0 §26：失败分类面板（主要类别 / 次要类别 / 阶段 / 信号 / 证据）。
                        §30 读完了却一份分析都没有（1.9.0 之前的 Run，或分析器自己没跑成）时
                        给一句说明，不摆空表格、不猜类别。 */}
                    {failureStage === "loaded" && failureAnalysis === null ? (
                      <div className="mb-4 rounded-2xl border border-border bg-muted/40 p-3 text-[11px] text-muted-foreground">
                        这个 Run 没有失败分析 —— v1.9.0 之前的产物没有 failure-analysis.json。
                      </div>
                    ) : (
                      <FailurePanel analysis={failureAnalysis} />
                    )}
                    {/* §37 Before / After Story：只有这次 Attempt 真的修过才给两个 Tab */}
                    {hasBeforeStory && (
                      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                        <button
                          type="button"
                          onClick={() => setStoryTab("before")}
                          className={`rounded-full border px-2.5 py-0.5 ${
                            showBefore
                              ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300"
                              : "border-border text-muted-foreground"
                          }`}
                          aria-label="Before Repair"
                        >
                          Before Repair
                        </button>
                        <button
                          type="button"
                          onClick={() => setStoryTab("after")}
                          className={`rounded-full border px-2.5 py-0.5 ${
                            showBefore
                              ? "border-border text-muted-foreground"
                              : "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300"
                          }`}
                          aria-label="After Repair"
                        >
                          After Repair
                        </button>
                        {repairOverride && !viewAttempt && (
                          <span className="text-muted-foreground">已应用一次手动修订（仅当前展示）</span>
                        )}
                      </div>
                    )}
                    <div className="prose prose-invert max-w-none prose-p:text-[15px] prose-p:leading-[26px]">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{shownStory}</ReactMarkdown>
                    </div>
                  </div>
                </ScrollArea>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground px-6 text-center">
                  <div className="size-14 rounded-2xl bg-muted/50 border border-border flex items-center justify-center">
                    <BookOpen className="h-6 w-6" />
                  </div>
                  <p className="text-[13px]">
                    {beatPlan ? "点击 Generate Story，根据剧情骨架写正文" : "先生成 Beat Plan（剧情骨架），再生成正文"}
                  </p>
                </div>
              )}
            </div>

            <div className="px-4 sm:px-5 py-3 border-t border-border shrink-0 flex gap-2">
              <Button onClick={handleGenerate} disabled={busy || !beatPlan}
                title={beatPlan ? "根据 Beat Plan 生成正文" : "Generate a beat plan first."}
                className="flex-1 h-10 rounded-full bg-violet-600 hover:bg-violet-500 text-white font-medium shadow-glow disabled:opacity-60">
                {generating ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating...</> : <><Sparkles className="h-4 w-4" /> Generate Story</>}
              </Button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
