'use client';

// 切图功能的模型解析层。
//
// 闭源版是「一个全局 API Key + 固定模型 ID 表」，所以调用处只需要一个 model 字符串。
// 开源版的模型由用户在设置里自建，凭据（apiKey / baseUrl / protocol）挂在每个模型上，
// 因此调用处必须拿到一整份配置。这个文件就是把 registry 的形状收敛成
// 切图各处需要的两个结构：SliceTextModel 与 SliceImageModel。
//
// 另有一处开源版特有的约束：切图的图片编辑（AI 透明化 / 背景补齐）需要
// 带 mask 的 /v1/images/edits，只有 openai 协议的模型有；见 isSliceCapableImageModel。

import { normalizeModelBaseUrl, normalizeTextModelBaseUrl } from '@/lib/model-endpoints';
import {
  getDefaultImageModel,
  getDefaultTextModel,
  getImageModelById,
  getSliceCapableImageModels,
  isSliceCapableImageModel,
  loadRegistry,
  type ImageModelConfig,
} from '@/lib/nova-models';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

/** 切图用到的文本模型（AI 拆图 / 网页复刻 / AI 重绘 SVG）。 */
export interface SliceTextModel {
  protocol: TextProviderProtocol;
  /** 上游模型 ID（发给供应商的那个），不是 registry 条目 id */
  modelId: string;
  apiKey: string;
  baseUrl: string;
  /** registry 条目的展示名，用于错误文案 */
  displayName: string;
}

/** 切图用到的图片编辑模型（AI 透明化 / 背景补齐）。 */
export interface SliceImageModel {
  /** registry 条目 id，持久化到 localStorage 的就是这个 */
  id: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  displayName: string;
}

/** 切图相关的文本任务。 */
export type SliceTextTask = 'sliceDecomposition' | 'sliceReconstruct';

const TASK_LABELS: Record<SliceTextTask, string> = {
  sliceDecomposition: 'AI 拆图',
  sliceReconstruct: '网页复刻',
};

/**
 * 取某个切图文本任务的默认模型。
 * @throws 未配置完整时抛出可直接展示的中文错误
 */
export function requireSliceTextModel(task: SliceTextTask): SliceTextModel {
  const registry = loadRegistry();
  const configured = getDefaultTextModel(registry, task);
  if (!configured?.apiKey || !configured.baseUrl || !configured.modelId) {
    throw new Error(
      `请先在「设置 → 模型」中为「${TASK_LABELS[task]}」指定一个配置完整的文本模型`,
    );
  }
  return {
    protocol: configured.protocol,
    modelId: configured.modelId,
    apiKey: configured.apiKey,
    baseUrl: normalizeTextModelBaseUrl(configured.protocol, configured.baseUrl),
    displayName: configured.name || configured.modelId,
  };
}

/** 不抛异常的版本，用于 UI 上的可用性判断（比如按钮是否置灰）。 */
export function hasSliceTextModel(task: SliceTextTask): boolean {
  const registry = loadRegistry();
  const configured = getDefaultTextModel(registry, task);
  return Boolean(configured?.apiKey && configured.baseUrl && configured.modelId);
}

function toSliceImageModel(model: ImageModelConfig): SliceImageModel {
  return {
    id: model.id,
    modelId: model.modelId,
    apiKey: model.apiKey,
    baseUrl: normalizeModelBaseUrl(model.protocol, model.baseUrl),
    displayName: model.name || model.modelId,
  };
}

/** 可用于切图图片编辑的模型列表（供 Tab 内选择器渲染）。 */
export function listSliceImageModels(): SliceImageModel[] {
  return getSliceCapableImageModels(loadRegistry()).map(toSliceImageModel);
}

/**
 * 按 registry 条目 id 解析图片编辑模型。
 *
 * @param preferredId Tab 内选择器记住的 id；为空或已失效时回退到设置里的默认项
 * @throws 一个可用模型都没有时抛出可直接展示的中文错误
 */
export function requireSliceImageModel(preferredId?: string | null): SliceImageModel {
  const registry = loadRegistry();

  if (preferredId) {
    const picked = getImageModelById(registry, preferredId);
    if (picked && isSliceCapableImageModel(picked) && picked.apiKey && picked.baseUrl && picked.modelId) {
      return toSliceImageModel(picked);
    }
  }

  const fallback = getDefaultImageModel(registry, 'sliceImageEdit');
  if (fallback && isSliceCapableImageModel(fallback) && fallback.apiKey && fallback.baseUrl && fallback.modelId) {
    return toSliceImageModel(fallback);
  }

  const first = getSliceCapableImageModels(registry)[0];
  if (first) return toSliceImageModel(first);

  throw new Error(
    '切图的 AI 图片编辑需要一个 OpenAI 协议的图片模型（如 GPT Image 2）。'
    + '请先在「设置 → 模型」中添加，Gemini 与 Grok 协议不支持带蒙版的局部编辑。',
  );
}

/** UI 用：当前是否存在可做切图图片编辑的模型。 */
export function hasSliceImageModel(): boolean {
  return getSliceCapableImageModels(loadRegistry()).length > 0;
}
