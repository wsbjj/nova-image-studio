'use client';

import {
  getTextProviderDescription,
  isTextProviderProtocol,
  type TextProviderProtocol,
} from '@/lib/nova-text-protocol';

export type ProviderProtocol = 'google' | 'openai' | 'grok';
export type ImageOutputSize = '512' | '1K' | '2K' | '4K';
export type BuiltinImagePresetId =
  | 'gemini-2.5-flash-image'
  | 'gemini-3-pro-image-preview'
  | 'gemini-3.1-flash-image-preview'
  | 'gemini-3.1-flash-lite-image'
  | 'gpt-image-2'
  | 'grok-imagine-image'
  | 'grok-imagine-image-quality'
  | 'grok-imagine-image-edit';

export interface ImageModelConfig {
  id: string;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  builtinPreset: BuiltinImagePresetId;
  maxRefImages: number;
  maxOutputSize: ImageOutputSize;
  supportsAdvancedParams: boolean;
}

export interface TextModelConfig {
  id: string;
  protocol: TextProviderProtocol;
  name: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  note?: string;
}

export interface BuiltinImagePreset {
  id: BuiltinImagePresetId;
  protocol: ProviderProtocol;
  name: string;
  modelId: string;
  baseUrl: string;
  maxRefImages: number;
  maxOutputSize: ImageOutputSize;
  supportsAdvancedParams: boolean;
}

export interface DefaultModels {
  textToImage: string;
  imageToImage: string;
  reversePrompt: string;
  agent: string;
  promptOptimize: string;
  imageDescribe: string;
  /** 图片切图的 AI 拆图（视觉定位切片与背景候选） */
  sliceDecomposition: string;
  /** 网页复刻 agent（多轮工具调用生成 HTML/CSS/JS） */
  sliceReconstruct: string;
  /**
   * 切图的图片编辑能力（AI 透明化、背景补齐）。
   * 与 textToImage / imageToImage 分开配置，因为这两项要求上游支持
   * 带 mask 的 /v1/images/edits，只有 openai 协议的模型满足（见 isSliceCapableImageModel）。
   */
  sliceImageEdit: string;
}

/** 文本类默认模型的 task key。 */
export type TextDefaultTask = keyof Pick<
  DefaultModels,
  'reversePrompt' | 'agent' | 'promptOptimize' | 'imageDescribe' | 'sliceDecomposition' | 'sliceReconstruct'
>;

const TEXT_DEFAULT_TASKS: TextDefaultTask[] = [
  'reversePrompt',
  'agent',
  'promptOptimize',
  'imageDescribe',
  'sliceDecomposition',
  'sliceReconstruct',
];

export interface NovaModelRegistry {
  imageModels: ImageModelConfig[];
  textModels: TextModelConfig[];
  defaults: DefaultModels;
}

const REGISTRY_KEY = 'nova-model-registry';

export const BUILTIN_IMAGE_PRESETS: Record<BuiltinImagePresetId, BuiltinImagePreset> = {
  'gemini-2.5-flash-image': {
    id: 'gemini-2.5-flash-image',
    protocol: 'google',
    name: 'Banana',
    modelId: 'gemini-2.5-flash-image',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 3,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
  },
  'gemini-3-pro-image-preview': {
    id: 'gemini-3-pro-image-preview',
    protocol: 'google',
    name: 'Banana Pro',
    modelId: 'gemini-3-pro-image-preview',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 14,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
  },
  'gemini-3.1-flash-image-preview': {
    id: 'gemini-3.1-flash-image-preview',
    protocol: 'google',
    name: 'Banana 2',
    modelId: 'gemini-3.1-flash-image-preview',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 14,
    maxOutputSize: '4K',
    supportsAdvancedParams: false,
  },
  'gemini-3.1-flash-lite-image': {
    id: 'gemini-3.1-flash-lite-image',
    protocol: 'google',
    name: 'Banana 2 Lite',
    modelId: 'gemini-3.1-flash-lite-image',
    baseUrl: 'https://generativelanguage.googleapis.com',
    maxRefImages: 14,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
  },
  'gpt-image-2': {
    id: 'gpt-image-2',
    protocol: 'openai',
    name: 'GPT Image 2',
    modelId: 'gpt-image-2',
    baseUrl: 'https://api.openai.com',
    maxRefImages: 16,
    maxOutputSize: '4K',
    supportsAdvancedParams: true,
  },
  'grok-imagine-image': {
    id: 'grok-imagine-image',
    protocol: 'grok',
    name: 'Grok Imagine',
    modelId: 'grok-imagine-image',
    baseUrl: 'https://api.x.ai',
    maxRefImages: 0,
    maxOutputSize: '1K',
    supportsAdvancedParams: false,
  },
  'grok-imagine-image-quality': {
    id: 'grok-imagine-image-quality',
    protocol: 'grok',
    name: 'Grok Imagine Quality',
    modelId: 'grok-imagine-image-quality',
    baseUrl: 'https://api.x.ai',
    maxRefImages: 0,
    maxOutputSize: '2K',
    supportsAdvancedParams: false,
  },
  'grok-imagine-image-edit': {
    id: 'grok-imagine-image-edit',
    protocol: 'grok',
    name: 'Grok Imagine Edit',
    modelId: 'grok-imagine-image-edit',
    baseUrl: 'https://api.x.ai',
    maxRefImages: 4,
    maxOutputSize: '2K',
    supportsAdvancedParams: false,
  },
};

export const BUILTIN_IMAGE_PRESET_OPTIONS = Object.values(BUILTIN_IMAGE_PRESETS).map((preset) => ({
  value: preset.id,
  label: preset.name,
}));

export const DEFAULT_TEXT_MODEL_TEMPLATES = [
  {
    protocol: 'openai-responses' as const,
    name: 'GPT 5.4 Mini',
    modelId: 'gpt-5.4-mini',
    baseUrl: 'https://api.openai.com',
    note: getTextProviderDescription('openai-responses'),
  },
  {
    protocol: 'google-gemini' as const,
    name: 'Gemini 2.5 Flash',
    modelId: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com',
    note: getTextProviderDescription('google-gemini'),
  },
  {
    protocol: 'anthropic-messages' as const,
    name: 'Claude Sonnet',
    modelId: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com',
    note: getTextProviderDescription('anthropic-messages'),
  },
  {
    protocol: 'openai-chat-completions' as const,
    name: 'OpenAI Compatible Chat',
    modelId: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com',
    note: getTextProviderDescription('openai-chat-completions'),
  },
];

export function getDefaultTextModelTemplate(protocol: TextProviderProtocol) {
  return DEFAULT_TEXT_MODEL_TEMPLATES.find((item) => item.protocol === protocol) || DEFAULT_TEXT_MODEL_TEMPLATES[0];
}

export const DEFAULT_DEFAULTS: DefaultModels = {
  textToImage: '',
  imageToImage: '',
  reversePrompt: '',
  agent: '',
  promptOptimize: '',
  imageDescribe: '',
  sliceDecomposition: '',
  sliceReconstruct: '',
  sliceImageEdit: '',
};

function isProviderProtocol(value: unknown): value is ProviderProtocol {
  return value === 'google' || value === 'openai' || value === 'grok';
}

function isBuiltinImagePresetId(value: unknown): value is BuiltinImagePresetId {
  return typeof value === 'string' && value in BUILTIN_IMAGE_PRESETS;
}

function normalizeImageOutputSize(value: unknown, fallback: ImageOutputSize): ImageOutputSize {
  return value === '512' || value === '1K' || value === '2K' || value === '4K'
    ? value
    : fallback;
}

function inferBuiltinPresetId(raw: Partial<ImageModelConfig>): BuiltinImagePresetId {
  const candidate = raw.builtinPreset || raw.id || raw.modelId;
  if (isBuiltinImagePresetId(candidate)) return candidate;
  const protocol = String(raw.protocol || '').trim();
  if (protocol === 'google') return 'gemini-3-pro-image-preview';
  if (protocol === 'grok') return 'grok-imagine-image';
  return 'gpt-image-2';
}

function normalizeImageModelConfig(raw: Partial<ImageModelConfig>): ImageModelConfig | null {
  const presetId = inferBuiltinPresetId(raw);
  const preset = BUILTIN_IMAGE_PRESETS[presetId];
  const id = String(raw.id || '').trim();
  if (!id) return null;

  const protocol = isProviderProtocol(raw.protocol) ? raw.protocol : preset.protocol;
  return {
    id,
    protocol,
    name: String(raw.name || '').trim(),
    modelId: String(raw.modelId || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || preset.baseUrl).trim(),
    builtinPreset: presetId,
    maxRefImages: Number.isFinite(raw.maxRefImages) && Number(raw.maxRefImages) >= 0
      ? Math.max(0, Math.floor(Number(raw.maxRefImages)))
      : preset.maxRefImages,
    maxOutputSize: normalizeImageOutputSize(raw.maxOutputSize, preset.maxOutputSize),
    supportsAdvancedParams: protocol === 'openai'
      ? (typeof raw.supportsAdvancedParams === 'boolean' ? raw.supportsAdvancedParams : preset.supportsAdvancedParams)
      : false,
  };
}

function normalizeTextModelConfig(raw: Partial<TextModelConfig>): TextModelConfig | null {
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const protocol = isTextProviderProtocol(raw.protocol) ? raw.protocol : 'openai-responses';
  const template = getDefaultTextModelTemplate(protocol);
  return {
    id,
    protocol,
    name: String(raw.name || '').trim(),
    modelId: String(raw.modelId || '').trim(),
    apiKey: String(raw.apiKey || '').trim(),
    baseUrl: String(raw.baseUrl || template.baseUrl).trim(),
    note: typeof raw.note === 'string' ? raw.note : (template.note || getTextProviderDescription(protocol)),
  };
}

function isCompleteImageModel(model: Partial<ImageModelConfig>): model is ImageModelConfig {
  return Boolean(
    model.id
    && model.name?.trim()
    && model.modelId?.trim()
    && model.apiKey?.trim()
    && model.baseUrl?.trim()
  );
}

function isCompleteTextModel(model: Partial<TextModelConfig>): model is TextModelConfig {
  return Boolean(
    model.id
    && model.name?.trim()
    && model.modelId?.trim()
    && model.apiKey?.trim()
    && model.baseUrl?.trim()
  );
}

function ensureImageModels(raw?: unknown): ImageModelConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeImageModelConfig((item || {}) as Partial<ImageModelConfig>))
    .filter((item): item is ImageModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
}

function ensureTextModels(raw?: unknown): TextModelConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => normalizeTextModelConfig((item || {}) as Partial<TextModelConfig>))
    .filter((item): item is TextModelConfig => Boolean(item))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
}

function ensureDefaults(raw: Partial<DefaultModels> | undefined, imageModels: ImageModelConfig[], textModels: TextModelConfig[]): DefaultModels {
  const completeImageModels = imageModels.filter(isCompleteImageModel);
  const completeTextModels = textModels.filter(isCompleteTextModel);
  const firstImageModelId = completeImageModels[0]?.id || '';
  const firstTextModelId = completeTextModels[0]?.id || '';
  const next = { ...DEFAULT_DEFAULTS, ...raw };

  if (!completeImageModels.some((model) => model.id === next.textToImage)) next.textToImage = firstImageModelId;
  if (!completeImageModels.some((model) => model.id === next.imageToImage)) next.imageToImage = firstImageModelId;
  for (const task of TEXT_DEFAULT_TASKS) {
    if (!completeTextModels.some((model) => model.id === next[task])) next[task] = firstTextModelId;
  }

  // 切图的图片编辑只能落在支持带 mask 编辑的模型上；没有这类模型时留空，
  // 由 UI 提示用户去添加，而不是硬塞一个注定 400 的模型。
  const sliceCapable = completeImageModels.filter(isSliceCapableImageModel);
  if (!sliceCapable.some((model) => model.id === next.sliceImageEdit)) {
    next.sliceImageEdit = sliceCapable[0]?.id || '';
  }

  return next;
}

/**
 * 该图片模型能否用于切图的图片编辑（AI 透明化 / 背景补齐）。
 *
 * 这两项都要打 `/v1/images/edits`，并且背景补齐还要传 `mask`。
 * 只有 openai 协议的模型有这个端点：Gemini 走 generateContent 没有 mask 语义，
 * Grok 的 edits 也不接受 mask 参数。所以在选择器层就把它们过滤掉，
 * 而不是等请求 400 才告诉用户。
 */
export function isSliceCapableImageModel(model: ImageModelConfig): boolean {
  return model.protocol === 'openai';
}

/** 可用于切图图片编辑的模型列表。 */
export function getSliceCapableImageModels(registry: NovaModelRegistry): ImageModelConfig[] {
  return getCompleteImageModels(registry).filter(isSliceCapableImageModel);
}

function getInitialRegistry(): NovaModelRegistry {
  return {
    imageModels: [],
    textModels: [],
    defaults: DEFAULT_DEFAULTS,
  };
}

export function loadRegistry(): NovaModelRegistry {
  if (typeof window === 'undefined') {
    return getInitialRegistry();
  }

  const raw = localStorage.getItem(REGISTRY_KEY);
  if (!raw) {
    return getInitialRegistry();
  }

  const parsed = JSON.parse(raw) as Partial<NovaModelRegistry>;
  const imageModels = ensureImageModels(parsed.imageModels);
  const textModels = ensureTextModels(parsed.textModels);
  const defaults = ensureDefaults(parsed.defaults, imageModels, textModels);
  return { imageModels, textModels, defaults };
}

export function saveRegistry(registry: NovaModelRegistry): void {
  if (typeof window === 'undefined') return;

  const imageModels = ensureImageModels(registry.imageModels);
  const textModels = ensureTextModels(registry.textModels);
  const normalized: NovaModelRegistry = {
    imageModels,
    textModels,
    defaults: ensureDefaults(registry.defaults, imageModels, textModels),
  };

  localStorage.setItem(REGISTRY_KEY, JSON.stringify(normalized));
}

export function getImageModelById(registry: NovaModelRegistry, id: string): ImageModelConfig | undefined {
  return registry.imageModels.find((model) => model.id === id);
}

export function getTextModelById(registry: NovaModelRegistry, id: string): TextModelConfig | undefined {
  return registry.textModels.find((model) => model.id === id);
}

export function getDefaultImageModel(
  registry: NovaModelRegistry,
  task: keyof Pick<DefaultModels, 'textToImage' | 'imageToImage' | 'sliceImageEdit'>,
): ImageModelConfig | undefined {
  return getImageModelById(registry, registry.defaults[task]);
}

export function getDefaultTextModel(
  registry: NovaModelRegistry,
  task: TextDefaultTask,
): TextModelConfig | undefined {
  return getTextModelById(registry, registry.defaults[task]);
}

export function getCompleteImageModels(registry: NovaModelRegistry): ImageModelConfig[] {
  return registry.imageModels.filter(isCompleteImageModel);
}

export function getCompleteTextModels(registry: NovaModelRegistry): TextModelConfig[] {
  return registry.textModels.filter(isCompleteTextModel);
}

export function getImageModelOutputSizes(model: ImageModelConfig): ImageOutputSize[] {
  switch (model.maxOutputSize) {
    case '4K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K', '4K']
        : ['1K', '2K', '4K'];
    case '2K':
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K', '2K']
        : ['1K', '2K'];
    case '512':
      return ['512'];
    case '1K':
    default:
      return model.builtinPreset === 'gemini-3.1-flash-image-preview'
        ? ['512', '1K']
        : ['1K'];
  }
}

export function generateModelId(prefix: string = 'model'): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
