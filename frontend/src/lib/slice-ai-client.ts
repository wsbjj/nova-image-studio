// 图片切图 AI 客户端
// 1A. AI 拆图：调用视觉模型流式返回 assets + backgrounds 文本
// 1B. AI 图片编辑：调用 /v1/images/edits 做背景补齐（带 mask）与 AI 透明化（不带 mask）
//
// 开源版与闭源版的两处差异：
//   1. 模型不再是固定 ID + 全局 Key，而是从 registry 解析出整份配置（见 slice-model-config）
//   2. 请求一律经后端代理转发（/api/nova/proxy/text 与 /api/nova/proxy/image-edit），
//      前端不直连上游 —— 多数上游不给浏览器发 CORS 头。

import {
  buildNovaAgentRequestBody,
  getNovaAgentIncompleteReason,
  postNovaProxyText,
  readNovaAgentTextStream,
  type NovaAgentRequestMessage,
} from '@/lib/nova-agent-protocol';
import {
  requireSliceImageModel,
  requireSliceTextModel,
  type SliceImageModel,
} from '@/lib/slice-model-config';
import {
  normalizeVectorSvg,
  sanitizeGeneratedSvg,
  SvgValidationError,
} from '@/lib/slice-vectorize';

/** 图片编辑代理端点。凭据走自定义头，body 是原样透传的 multipart。 */
const NOVA_PROXY_IMAGE_EDIT_ENDPOINT = '/api/nova/proxy/image-edit';

/**
 * 切图各处的默认思考强度。
 *
 * 开源版的 registry 没有「思考等级」这一维（模型由用户自建，各家档位也不统一），
 * 所以这里给一个固定值，由 buildNovaAgentRequestBody 按协议自动降级：
 * Responses 走 reasoning.effort、Gemini 折算成 thinkingBudget、其余协议忽略。
 */
const SLICE_REASONING_EFFORT = 'medium';

/** 发起一次图片编辑请求。表单内容由调用方决定（是否带 mask、是否要透明背景）。 */
async function postImageEdit(
  model: SliceImageModel,
  formData: FormData,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(NOVA_PROXY_IMAGE_EDIT_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-nova-base-url': model.baseUrl,
      'x-nova-api-key': model.apiKey,
    },
    body: formData,
    signal,
  });
  if (!response.ok) {
    throw await readHttpError(response);
  }
  return await readImageResponse(response);
}

// ===== 结果类型 =====

export interface DecompositionResult {
  assets: Array<{
    name: string;
    kind: string;
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number | null;
    containsEmbeddedText: boolean;
    reason: string;
  }>;
  backgrounds: Array<{
    id: string;
    name: string;
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number | null;
    reason: string;
    bakedVisuals: string[];
    overlays: Array<{
      id: string;
      name: string;
      kind: string;
      bbox: { x: number; y: number; width: number; height: number };
      confidence: number | null;
      reason: string;
    }>;
  }>;
  /** 模型给出但被校验丢弃的切图条目数（kind 非法或 bbox 无效） */
  droppedAssets: number;
  /** 模型给出但被校验丢弃的背景候选数 */
  droppedBackgrounds: number;
}

// ===== 解析常量 =====

/** 合法的前景切片资产类型 */
const ALLOWED_ASSET_KINDS = new Set([
  'icon',
  'avatar',
  'illustration',
  'photo',
  'product-image',
  'complex-decoration',
  'complex-chart',
  'logo',
]);

/** 合法的背景覆盖层类型 */
const ALLOWED_BACKGROUND_OVERLAY_KINDS = new Set(['code-overlay', 'raster-overlay']);

/** 最多保留的背景候选数 */
const MAX_BACKGROUND_CANDIDATES = 6;
/** 单个背景最多保留的覆盖层数 */
const MAX_BACKGROUND_OVERLAYS = 48;
/** 背景最小尺寸（像素） */
const MIN_BACKGROUND_SIZE = 24;
/** 覆盖层最小尺寸（像素） */
const MIN_OVERLAY_SIZE = 4;
/** 切片资产最小尺寸（像素） */
const MIN_SLICE_ASSET_SIZE = 4;

/**
 * 拆图请求的输出 token 预算。
 * 整页拆解要输出几十个 bbox 条目，responses 协议下 reasoning 与正文共用额度，
 * 推理与正文共用额度，因此显式给出较宽的预算，配合流式读取避免长 JSON 被截断。
 */
const DECOMPOSITION_MAX_OUTPUT_TOKENS = 16_384;

/**
 * AI 重绘 SVG 的输出 token 预算。
 * 单个图标的 SVG 路径数据比拆图 JSON 短得多，但渐变与多层路径仍可能上千 token；
 * 上游服务端给 4096，这里放宽一档以容纳推理占用。
 */
const AI_SVG_MAX_OUTPUT_TOKENS = 8_192;

// ===== 1A. AI 拆图（视觉模型） =====

/**
 * 构建背景拆解提示词：合并切图资产识别 + 背景拆解，
 * 一次请求同时返回 assets（可复用 PNG 切片）与 backgrounds（被遮挡的可复用背景）。
 */
function buildBackgroundDecompositionPrompt({
  width,
  height,
  sourceImageName,
}: {
  width: number;
  height: number;
  sourceImageName?: string;
}): string {
  return [
    'Analyze the attached UI screenshot and return both reusable PNG crops and reusable visual background restoration plans.',
    `Source image: ${sourceImageName || 'source-ui.png'}.`,
    `All bbox values must use original ${width}x${height} image pixel coordinates. Do not normalize to 750px or percentages.`,
    'For assets, use only these kind values: icon, avatar, illustration, photo, product-image, complex-decoration, complex-chart, logo.',
    'Return an asset when its exact raster appearance cannot be reliably reconstructed as ordinary text or simple CSS shapes.',
    'A logo, badge, or illustration containing inseparable artistic text may be returned as one complete PNG crop.',
    'Do not return ordinary UI text, button backgrounds, cards, dividers, simple rectangles, circles, or layout containers as assets.',
    'Do not merge visually independent assets merely because their boxes overlap. Preserve source reading order.',
    'Give every asset and background a specific semantic English name in lowercase snake_case, such as woodcarving_course_cover or old_street_hero_background.',
    'Names must not contain Chinese, spaces, hyphens, file extensions, or generic labels such as asset_01. Use slice_01 only when the visual meaning truly cannot be identified.',
    'Find continuous illustrated, photographic, textured, or decorative background regions that are partially covered by obvious interface controls.',
    'Preserve baked visual content inside each background: illustrations, scenery, products, decorative frames, artistic text, calligraphy, campaign lettering, and integrated branding.',
    'Classify only obvious foreground UI as code-overlay: navigation controls, ordinary buttons, cards, menus, tabs, form controls, checkboxes, and ordinary interface text placed over the background.',
    'Use raster-overlay only for a visually independent foreground bitmap that cannot be accurately rebuilt with text, CSS, or a simple vector icon.',
    'An independent raster-overlay may also appear in assets when it should be preserved as a reusable PNG crop.',
    'Do not mark artistic text or integrated branding as an overlay merely because it contains readable characters.',
    'Each overlay bbox must intersect its parent background bbox.',
    'Return one JSON object with this shape:',
    '{"assets":[{"name":"specific_english_asset_name","kind":"icon","bbox":{"x":0,"y":0,"width":8,"height":8},"confidence":0.0,"containsEmbeddedText":false,"reason":"why raster is required"}],"backgrounds":[{"id":"background_01","name":"specific_english_background_name","bbox":{"x":0,"y":0,"width":100,"height":100},"confidence":0.0,"reason":"why this is a reusable background","bakedVisuals":["content that must remain"],"overlays":[{"id":"overlay_01","name":"overlay name","kind":"code-overlay","bbox":{"x":0,"y":0,"width":20,"height":20},"confidence":0.0,"reason":"why this is placed above the background"}]}]}',
    'Return an empty assets array when no reusable PNG crop exists.',
    'Return an empty backgrounds array when no reusable covered background exists.',
    'Return JSON only. Do not include Markdown or explanations outside the JSON object.',
  ].join('\n');
}

/**
 * 模型返回空文本时，尽量说明原因。
 * responses 协议在命中输出上限时会给 status='incomplete' + incomplete_details.reason='max_output_tokens'，
 * 这类信息不透出的话，用户只会看到"未返回有效切图"而无从下手。
 */
function describeEmptyOutput(data: unknown): string {
  const record = (data && typeof data === 'object' ? data : {}) as {
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
    error?: { message?: unknown } | null;
  };
  const errorMessage = record.error?.message;
  if (typeof errorMessage === 'string' && errorMessage.trim()) {
    return `模型拆图失败：${errorMessage}`;
  }
  const reason = record.incomplete_details?.reason;
  if (reason === 'max_output_tokens') {
    return '模型输出超出长度上限，拆图结果不完整，请降低推理强度或改用输出更长的文本模型';
  }
  if (typeof reason === 'string' && reason.trim()) {
    return `模型没有返回拆图内容（${reason}）`;
  }
  if (record.status === 'incomplete') {
    return '模型返回的拆图结果不完整，请重试';
  }
  return '模型没有返回拆图内容，请重试或更换文本模型';
}

/**
 * 构建 JSON 修复提示词：模型上一次返回的文本解析失败时，
 * 再发一次**不带图片**的请求让它修复自己的输出。
 * 明确禁止增删/合并/去重条目，避免"修复"变成重新识别。
 */
function buildJsonRepairPrompt(rawText: string): string {
  return [
    'The following model output was supposed to be a single JSON object but failed to parse.',
    'Repair it into strictly valid JSON without adding, deleting, merging, or deduplicating asset, background, or overlay entries.',
    'Preserve every numeric value exactly as written. Do not recompute or normalize coordinates.',
    'Return JSON only. Do not include Markdown fences or any explanation.',
    '--- BEGIN OUTPUT ---',
    rawText.slice(0, 60000),
    '--- END OUTPUT ---',
  ].join('\n');
}

/**
 * 请求视觉模型对源图进行切图拆解，返回 assets + backgrounds。
 * 走文本模型 SSE 流式请求；流结束后再解析完整 JSON。
 *
 * 解析失败时会自动发起一次无图的 JSON 修复重试（源项目服务端的同名机制）——
 * 视觉模型输出长 JSON 时偶发截断/尾逗号，直接判空会让用户白等一次昂贵的请求。
 */
export async function requestSliceDecomposition(params: {
  sourceImageDataUrl: string;
  width: number;
  height: number;
  sourceImageName?: string;
  signal?: AbortSignal;
  /** 修复重试开始时回调，供 UI 提示"正在修复模型返回的拆图计划 JSON" */
  onRepairAttempt?: () => void;
  /** 每次新的模型请求开始时回调，UI 可清空上一次流文本。 */
  onStreamStart?: (phase: 'decomposition' | 'repair') => void;
  /** 模型文本增量回调，第二个参数为当前请求已累计文本。 */
  onDelta?: (delta: string, accumulated: string) => void;
}): Promise<DecompositionResult> {
  const {
    sourceImageDataUrl,
    width,
    height,
    sourceImageName,
    signal,
    onRepairAttempt,
    onStreamStart,
    onDelta,
  } = params;

  const textModel = requireSliceTextModel('sliceDecomposition');
  const protocol = textModel.protocol;
  const prompt = buildBackgroundDecompositionPrompt({ width, height, sourceImageName });

  const post = async (
    input: NovaAgentRequestMessage[],
    phase: 'decomposition' | 'repair',
  ): Promise<string> => {
    onStreamStart?.(phase);
    const response = await postNovaProxyText({
      protocol,
      baseUrl: textModel.baseUrl,
      apiKey: textModel.apiKey,
      model: textModel.modelId,
      stream: true,
      requestBody: buildNovaAgentRequestBody({
        protocol,
        model: textModel.modelId,
        stream: true,
        effort: SLICE_REASONING_EFFORT,
        maxOutputTokens: DECOMPOSITION_MAX_OUTPUT_TOKENS,
        messages: input,
      }),
      signal,
    });
    if (!response.ok) {
      throw await readHttpError(response);
    }
    const streamResult = await readNovaAgentTextStream(response, protocol, signal, onDelta);
    const text = streamResult.text;
    const incompleteReason = getNovaAgentIncompleteReason(streamResult.finalPayload);
    if (incompleteReason === 'max_output_tokens') {
      throw new Error('模型输出超出长度上限，拆图结果不完整，请降低推理强度或改用输出更长的文本模型');
    }
    if (incompleteReason || !streamResult.complete) {
      throw new Error('模型流式响应提前结束，拆图结果不完整，请重试');
    }
    if (!text.trim()) {
      // 空文本多半是命中输出上限或被安全策略拦截，静默返回 '' 会退化成"未返回有效切图"
      throw new Error(describeEmptyOutput(streamResult.finalPayload));
    }
    return text;
  };

  const text = await post([
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: prompt },
        { type: 'image' as const, imageDataUrl: sourceImageDataUrl },
      ],
    },
  ], 'decomposition');

  const parsed = extractJsonObject(text);
  if (parsed !== null) {
    return parseDecompositionData(parsed, width, height);
  }

  // 首次解析失败 → 无图修复重试
  onRepairAttempt?.();
  const repaired = await post([
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: buildJsonRepairPrompt(text) }],
    },
  ], 'repair');
  const repairedData = extractJsonObject(repaired);
  if (repairedData === null) {
    throw new Error('模型返回的拆图结果无法解析为 JSON，请重试或更换文本模型');
  }
  return parseDecompositionData(repairedData, width, height);
}

// ===== 拆解结果解析 =====

/** 像素边界框 */
interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 从模型返回文本中提取首个 JSON 对象。
 * 先去掉 ```json 围栏，再取第一个 { 到最后一个 } 之间的内容解析。
 */
function extractJsonObject(text: string): unknown {
  if (!text) return null;
  let raw = text.trim();
  // 去掉首尾的 ```json / ``` 围栏
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```[a-zA-Z]*\s*/, '');
    if (raw.endsWith('```')) {
      raw = raw.slice(0, -3).trim();
    }
  }
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

/**
 * 归一化 bbox：clamp 到 bounds 范围内，宽高小于 minSize 视为无效返回 null。
 */
function normalizeBox(
  bbox: unknown,
  bounds: { width: number; height: number },
  minSize: number,
): Bbox | null {
  if (!bbox || typeof bbox !== 'object') return null;
  const b = bbox as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const x = Number(b.x);
  const y = Number(b.y);
  const w = Number(b.width);
  const h = Number(b.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }

  const maxX = bounds.width;
  const maxY = bounds.height;

  // 负宽高等价于从对角点起算，先归一化成正矩形（模型偶发反向输出，直接丢弃会白丢一个切图）
  const rawX = w < 0 ? x + w : x;
  const rawY = h < 0 ? y + h : y;
  const rawW = Math.abs(w);
  const rawH = Math.abs(h);

  // clamp 起点
  const clampedX = Math.max(0, Math.min(rawX, maxX));
  const clampedY = Math.max(0, Math.min(rawY, maxY));
  // clamp 终点（起点被 clamp 到 0 时要保留原终点，否则整体会被右移）
  const endX = Math.min(Math.max(rawX + rawW, clampedX), maxX);
  const endY = Math.min(Math.max(rawY + rawH, clampedY), maxY);

  const newWidth = endX - clampedX;
  const newHeight = endY - clampedY;
  if (newWidth < minSize || newHeight < minSize) return null;

  return { x: clampedX, y: clampedY, width: newWidth, height: newHeight };
}

/** 归一化置信度：非有限数字返回 null，否则 clamp 到 [0, 1] */
function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** 截断字符串到最大长度 */
function truncateString(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 提取字符串数组，丢弃非字符串元素 */
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 解析视觉模型返回的 JSON 文本为 DecompositionResult。
 * - assets：kind 必须在允许集合内，bbox 归一化到画布
 * - backgrounds：bbox 归一化到画布；overlays 归一化到父背景 bbox，kind 必须在覆盖层集合内
 * - confidence 归一化到 [0,1]；name/reason 做长度截断
 */
export function parseBackgroundDecompositionText(
  text: string,
  width: number,
  height: number,
): DecompositionResult {
  const data = extractJsonObject(text);
  if (data === null) {
    return { assets: [], backgrounds: [], droppedAssets: 0, droppedBackgrounds: 0 };
  }
  return parseDecompositionData(data, width, height);
}

/**
 * 解析已经反序列化好的拆图 JSON 对象。
 * 与 parseBackgroundDecompositionText 分离，避免同一段文本被 JSON.parse 两次。
 */
export function parseDecompositionData(
  raw: unknown,
  width: number,
  height: number,
): DecompositionResult {
  const canvasBounds = { width, height };
  const data = (raw && typeof raw === 'object' ? raw : {}) as {
    assets?: unknown;
    backgrounds?: unknown;
  };

  // 被丢弃的条目数：模型给了但 kind 非法/bbox 无效，用于向用户说明"为什么只出了 N 个"
  let droppedAssets = 0;
  let droppedBackgrounds = 0;

  // ===== assets =====
  const assets: DecompositionResult['assets'] = [];
  if (Array.isArray(data.assets)) {
    for (const raw of data.assets) {
      if (!raw || typeof raw !== 'object') {
        droppedAssets += 1;
        continue;
      }
      const a = raw as {
        kind?: unknown;
        bbox?: unknown;
        name?: unknown;
        confidence?: unknown;
        containsEmbeddedText?: unknown;
        reason?: unknown;
      };
      if (typeof a.kind !== 'string' || !ALLOWED_ASSET_KINDS.has(a.kind)) {
        droppedAssets += 1;
        continue;
      }
      const bbox = normalizeBox(a.bbox, canvasBounds, MIN_SLICE_ASSET_SIZE);
      if (!bbox) {
        droppedAssets += 1;
        continue;
      }
      assets.push({
        name: truncateString(typeof a.name === 'string' ? a.name : '', 120),
        kind: a.kind,
        bbox,
        confidence: normalizeConfidence(a.confidence),
        containsEmbeddedText:
          typeof a.containsEmbeddedText === 'boolean' ? a.containsEmbeddedText : false,
        reason: truncateString(typeof a.reason === 'string' ? a.reason : '', 300),
      });
    }
  }

  // ===== backgrounds =====
  const backgrounds: DecompositionResult['backgrounds'] = [];
  if (Array.isArray(data.backgrounds)) {
    for (const raw of data.backgrounds) {
      if (!raw || typeof raw !== 'object') {
        droppedBackgrounds += 1;
        continue;
      }
      if (backgrounds.length >= MAX_BACKGROUND_CANDIDATES) break;
      const bg = raw as {
        id?: unknown;
        name?: unknown;
        bbox?: unknown;
        confidence?: unknown;
        reason?: unknown;
        bakedVisuals?: unknown;
        overlays?: unknown;
      };
      const bbox = normalizeBox(bg.bbox, canvasBounds, MIN_BACKGROUND_SIZE);
      if (!bbox) {
        droppedBackgrounds += 1;
        continue;
      }

      // overlays：bbox 归一化到父背景 bbox，kind 必须合法
      const overlays: DecompositionResult['backgrounds'][number]['overlays'] = [];
      if (Array.isArray(bg.overlays)) {
        for (const oraw of bg.overlays) {
          if (!oraw || typeof oraw !== 'object') continue;
          if (overlays.length >= MAX_BACKGROUND_OVERLAYS) break;
          const o = oraw as {
            id?: unknown;
            name?: unknown;
            kind?: unknown;
            bbox?: unknown;
            confidence?: unknown;
            reason?: unknown;
          };
          if (typeof o.kind !== 'string' || !ALLOWED_BACKGROUND_OVERLAY_KINDS.has(o.kind)) continue;
          const oBbox = normalizeBox(o.bbox, bbox, MIN_OVERLAY_SIZE);
          if (!oBbox) continue;
          overlays.push({
            id:
              typeof o.id === 'string' && o.id
                ? o.id
                : `overlay_${backgrounds.length + 1}_${overlays.length + 1}`,
            name: truncateString(typeof o.name === 'string' ? o.name : '', 120),
            kind: o.kind,
            bbox: oBbox,
            confidence: normalizeConfidence(o.confidence),
            reason: truncateString(typeof o.reason === 'string' ? o.reason : '', 300),
          });
        }
      }

      backgrounds.push({
        id:
          typeof bg.id === 'string' && bg.id
            ? bg.id
            : `background_${backgrounds.length + 1}`,
        name: truncateString(typeof bg.name === 'string' ? bg.name : '', 120),
        bbox,
        confidence: normalizeConfidence(bg.confidence),
        reason: truncateString(typeof bg.reason === 'string' ? bg.reason : '', 300),
        bakedVisuals: normalizeStringArray(bg.bakedVisuals),
        overlays,
      });
    }
  }

  return { assets, backgrounds, droppedAssets, droppedBackgrounds };
}

// ===== 1B. AI 补齐（图片编辑） =====

/**
 * 构建 AI 补齐提示词。
 *
 * 三处与移植版的关键差异：
 * 1. 携带 bakedVisuals —— 不写进提示词的话，模型会把插画、书法、艺术字、品牌元素
 *    当成要清除的前景一起抹掉，这是背景还原"效果很差"的主因之一。
 * 2. regions 应传**已外扩并映射到请求画布坐标**的矩形，与实际发出的蒙版保持一致。
 * 3. 可声明确切画布尺寸，配合前端的 letterbox 往返避免返回图尺寸漂移。
 */
export function buildInpaintPrompt(
  assetName: string,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
  options: { bakedVisuals?: string[]; canvasWidth?: number; canvasHeight?: number } = {},
): string {
  const { bakedVisuals = [], canvasWidth, canvasHeight } = options;
  const lines = [
    `Restore the background hidden by foreground UI slices in the image named "${assetName}".`,
    'Reference image 1 is the current slice with the reconstruction area already cleared to transparent pixels.',
    'Reference image 2 is a black-and-white mask aligned pixel-for-pixel with image 1. Reconstruct only the white pixels; black pixels are context and must remain unchanged.',
    `Only reconstruct these slice-local rectangles: ${JSON.stringify(regions)}.`,
  ];

  // 必须保留的画面内容：紧跟重建指令，权重高于后面的通用约束
  if (bakedVisuals.length > 0) {
    lines.push(
      `The following baked visual content is part of the background and must remain unchanged: ${bakedVisuals.join('; ')}.`,
      'Do not remove or rewrite artistic text, calligraphy, integrated branding, illustrations, products, scenery, or decoration.',
    );
  }

  lines.push(
    'Inside those rectangles, remove the overlapping foreground elements and infer the original background from the surrounding pixels, continuing colors, textures, gradients, lighting, perspective, and background details naturally.',
    "Match the protected source pixels' white balance, color temperature, tint, exposure, gamma, contrast, saturation, black point, and white point exactly.",
    'Do not apply global relighting, HDR, auto-enhancement, cinematic grading, sharpening, or color styling.',
    'Outside those rectangles, reproduce the input pixels unchanged. Do not redesign, crop, resize, reposition, sharpen, recolor, or add any object or text.',
    canvasWidth && canvasHeight
      ? `Return one image at exactly ${canvasWidth}x${canvasHeight} pixels and preserve the original background and opacity. Avoid seams, halos, duplicated elements, or rectangular patch edges.`
      : 'Return one image at the same canvas size and preserve the original background and opacity. Avoid seams, halos, duplicated elements, or rectangular patch edges.',
  );

  return lines.join('\n');
}

/**
 * AI 透明：把切图交给图片编辑端点抠背景，返回透明 PNG Blob。
 *
 * 与 requestSliceInpaint 的区别是不传 mask —— 抠背景是整图操作，
 * 且必须显式声明 background=transparent，否则多数供应商会回一张白底图。
 *
 * 提示词移植自 imagetoslice/src/ui/services/ai-helpers.js buildAiTransparentPrompt()，
 * 全是「不要做什么」的约束：模型一旦自由发挥就会顺手重绘主体，
 * 那样切图和原图对不上，透明化就失去意义了。
 */
export function buildAiTransparentPrompt(): string {
  return [
    'Use the attached image as the only source of truth.',
    'Only remove the background and make it transparent.',
    "Preserve the subject's shape, colors, proportions, angle, shadows, antialiased edges, composition, and canvas size exactly.",
    'Do not redraw, regenerate, complete, replace, crop, resize, reposition, recolor, or add anything.',
    'Output one transparent PNG with the original canvas dimensions.',
  ].join('\n');
}

export async function requestAiTransparent(params: {
  /** registry 条目 id（Tab 内选择器记住的那个），留空则回退到设置里的默认项 */
  model?: string | null;
  imageBlob: Blob;
  size?: string;
  signal?: AbortSignal;
}): Promise<Blob> {
  const { model, imageBlob, size, signal } = params;
  const imageModel = requireSliceImageModel(model);

  const formData = new FormData();
  formData.append('model', imageModel.modelId);
  formData.append('image', imageBlob, 'image.png');
  formData.append('prompt', buildAiTransparentPrompt());
  formData.append('background', 'transparent');
  formData.append('output_format', 'png');
  if (size) {
    formData.append('size', size);
  }

  return await postImageEdit(imageModel, formData, signal);
}

/**
 * AI 重绘 SVG 的提示词。
 * 移植自 imagetoslice 的 buildAiRedrawPrompt + server.js buildAssetSvgPrompt，
 * 核心是「1:1 描摹优先于好看」：不加约束时模型会交出一个风格统一的通用图标，
 * 而我们要的是这一个图标的忠实矢量化。
 */
export function buildAiSvgPrompt(assetName: string, width: number, height: number): string {
  return [
    'You are a senior SVG vectorization engineer and UI icon restoration expert.',
    `Vectorize the attached sliced UI asset as an editable SVG named "${assetName || 'ui_asset'}".`,
    'The attached image is the only source of truth. The result should look carefully traced and vectorized, not redesigned.',
    '',
    'Core principles:',
    '- 1:1 similarity is more important than making a prettier new icon.',
    '- Faithful restoration is more important than simplification.',
    '- Do not redesign, restyle, normalize into an icon set, or change the icon category.',
    '- Do not simplify key structures, add elements absent from the source, or substitute a generic replacement icon.',
    '',
    'Silently analyze before drawing: icon type, main contour blocks, subject position, scale, padding, direction, tilt, visual weight, asymmetry, internal highlights, shadows, facets, cutouts, lines, decoration, layer order, and color relationships.',
    'The outer silhouette is mandatory and must closely match the source. Preserve rounded corners, sharp corners, concave/convex areas, notches, tilt, asymmetry, and special curves.',
    'For abstract icons and symbols, prioritize geometric contour accuracy over illustration style. Do not round, blobify, inflate, smooth, or regularize the shape unless the source does.',
    'Keep only details actually present in the source. Preserve highlight and gradient placement, internal negative shapes, shadow strength, detail size, angle, and layer order.',
    'Clean only screenshot noise, blur, compression artifacts, background contamination, and neighboring UI fragments.',
    'Match source colors, gradient direction, opacity, highlights, and dark areas. If the source is flat color, keep it flat.',
    '',
    'Output rules:',
    '- Use editable path/circle/rect/ellipse/polygon/line/g/defs/linearGradient/radialGradient/mask/clipPath elements. Prefer Bezier paths for main contours.',
    '- Do not embed raster images, base64, external href, HTML, foreignObject, CSS imports, script, or animation.',
    `- Return raw SVG only, with a transparent background and viewBox="0 0 ${width} ${height}".`,
    '- Preserve the original crop padding. Do not arbitrarily fill the canvas.',
    '- Return the SVG markup with no Markdown fences and no explanation.',
  ].join('\n');
}

/**
 * 请求视觉模型直接产出 SVG 源码。
 *
 * 校验失败会用「更严格的纯矢量」提示词重试一次（对齐上游的 retry-clean-vector）：
 * 最常见的失败是模型内嵌 base64 位图冒充矢量，明确点出来往往一次就能纠正。
 *
 * @returns 已通过 sanitizeGeneratedSvg 校验、且 viewBox 已对齐切图尺寸的 SVG 源码
 */
export async function requestAiSvg(params: {
  imageDataUrl: string;
  assetName: string;
  width: number;
  height: number;
  signal?: AbortSignal;
  /** 进入重试时回调，供 UI 提示"正在重试" */
  onRetry?: () => void;
  onStreamStart?: () => void;
  onDelta?: (delta: string, accumulated: string) => void;
}): Promise<string> {
  const { imageDataUrl, assetName, width, height, signal, onRetry, onStreamStart, onDelta } = params;

  const textModel = requireSliceTextModel('sliceDecomposition');
  const protocol = textModel.protocol;
  const basePrompt = buildAiSvgPrompt(assetName, width, height);

  const post = async (prompt: string): Promise<string> => {
    onStreamStart?.();
    const response = await postNovaProxyText({
      protocol,
      baseUrl: textModel.baseUrl,
      apiKey: textModel.apiKey,
      model: textModel.modelId,
      stream: true,
      requestBody: buildNovaAgentRequestBody({
        protocol,
        model: textModel.modelId,
        stream: true,
        effort: SLICE_REASONING_EFFORT,
        maxOutputTokens: AI_SVG_MAX_OUTPUT_TOKENS,
        messages: [
          {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text: prompt },
              { type: 'image' as const, imageDataUrl },
            ],
          },
        ],
      }),
      signal,
    });
    if (!response.ok) {
      throw await readHttpError(response);
    }
    const streamResult = await readNovaAgentTextStream(response, protocol, signal, onDelta);
    if (getNovaAgentIncompleteReason(streamResult.finalPayload) === 'max_output_tokens') {
      throw new Error('模型输出超出长度上限，SVG 不完整。请重新切更小的区域，或降低推理强度');
    }
    if (!streamResult.text.trim()) {
      throw new Error(describeEmptyOutput(streamResult.finalPayload));
    }
    return streamResult.text;
  };

  try {
    return normalizeVectorSvg(sanitizeGeneratedSvg(await post(basePrompt)), width, height);
  } catch (error) {
    // 只对校验失败重试；网络错误、额度错误、用户取消都直接抛出
    if (!(error instanceof SvgValidationError)) throw error;
    onRetry?.();
    const retryPrompt = [
      basePrompt,
      '',
      `The previous attempt was rejected: ${error.message}.`,
      'Return ONE clean vector SVG only. It must contain real vector shape elements (path/rect/circle/ellipse/polygon/line).',
      'It must NOT contain <image>, <script>, <foreignObject>, href, xlink:href, or any data:image base64 payload.',
      `The root <svg> element must carry viewBox="0 0 ${width} ${height}".`,
    ].join('\n');
    return normalizeVectorSvg(sanitizeGeneratedSvg(await post(retryPrompt)), width, height);
  }
}

/**
 * 调用图片编辑端点（/v1/images/edits）按蒙版补齐背景。
 * @returns 编辑后的图片 Blob
 */
export async function requestSliceInpaint(params: {
  /** registry 条目 id（Tab 内选择器记住的那个），留空则回退到设置里的默认项 */
  model?: string | null;
  imageBlob: Blob;
  maskBlob: Blob;
  prompt: string;
  size?: string;
  signal?: AbortSignal;
}): Promise<Blob> {
  const { model, imageBlob, maskBlob, prompt, size, signal } = params;
  const imageModel = requireSliceImageModel(model);

  const formData = new FormData();
  formData.append('model', imageModel.modelId);
  formData.append('image', imageBlob, 'image.png');
  formData.append('mask', maskBlob, 'mask.png');
  formData.append('prompt', prompt);
  if (size) {
    formData.append('size', size);
  }

  return await postImageEdit(imageModel, formData, signal);
}

// ===== 工具函数 =====

/**
 * 解析 /v1/images/edits 的响应为图片 Blob。
 * 该端点返回 JSON（data[0].b64_json），直接 response.blob() 会得到
 * application/json 的 Blob，导致后续 loadImage() 失败并卡住转圈。
 */
export async function readImageResponse(response: Response): Promise<Blob> {
  const contentType = response.headers.get('content-type') || '';

  // 极少数网关会直接回传图片二进制，此时无需解析 JSON
  if (contentType.startsWith('image/')) {
    return await response.blob();
  }

  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`图片编辑接口返回了无法解析的内容：${text.slice(0, 200)}`);
  }

  const item = pickImageItem(payload);
  const base64 = firstString(item?.b64_json, item?.image_base64, item?.base64);
  if (base64) {
    const format = firstString(
      (payload as Record<string, unknown> | null)?.output_format as string | undefined,
      'png',
    );
    return base64ToBlob(base64, `image/${format === 'jpg' ? 'jpeg' : format}`);
  }

  const remoteUrl = firstString(item?.url, item?.image_url);
  if (remoteUrl) {
    const remote = await fetch(remoteUrl);
    if (!remote.ok) {
      throw new Error(`拉取图片编辑结果失败：${remote.status} ${remote.statusText}`);
    }
    return await remote.blob();
  }

  const message = firstString(
    (payload as Record<string, unknown> | null)?.error as string | undefined,
    ((payload as Record<string, { message?: string }> | null)?.error as { message?: string })
      ?.message,
  );
  throw new Error(message || '图片编辑接口未返回图片数据');
}

interface ImageResponseItem {
  b64_json?: string;
  image_base64?: string;
  base64?: string;
  url?: string;
  image_url?: string;
}

/** 从响应体中取出第一个含图片数据的条目，兼容顶层字段。 */
function pickImageItem(payload: unknown): ImageResponseItem | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const list = Array.isArray(root.data) ? (root.data as ImageResponseItem[]) : [];
  const hit = list.find(
    (entry) =>
      entry && (entry.b64_json || entry.image_base64 || entry.base64 || entry.url || entry.image_url),
  );
  return hit || (root as ImageResponseItem);
}

function firstString(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** base64 解码为 Blob，剥离可能存在的 data URL 前缀。 */
function base64ToBlob(base64: string, mimeType: string): Blob {
  const cleaned = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/** 读取 HTTP 错误响应并构造 Error，优先解析 JSON 中的 error.message */
async function readHttpError(response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = await response.text();
  } catch {
    /* ignore */
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail);
      const message = parsed?.error?.message || parsed?.error || parsed?.message;
      if (typeof message === 'string' && message.length > 0) {
        return new Error(`${response.status} ${response.statusText}: ${message}`);
      }
    } catch {
      /* not JSON */
    }
  }
  return new Error(
    `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
  );
}
