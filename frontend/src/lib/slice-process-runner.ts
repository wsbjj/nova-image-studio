// 四个资产处理操作的执行层：算法透明 / AI透明 / 算法SVG / AI SVG。
//
// 只负责「拿到输入 → 产出结果」，不碰 store 与历史：写库由 SliceEditor 统一 commit，
// 这样批量执行才能整批算一条撤销。
//
// 批量策略：算法类可批量（纯本地计算，失败一个不影响其余）；
// AI 类只允许逐个触发 —— 批量 AI 会在用户点一次按钮后连续扣费，
// 且中途失败难以界定已消耗多少额度，所以入口层就不提供批量。

import { requestAiSvg, requestAiTransparent } from './slice-ai-client';
import { letterboxToSize, restoreFromLetterbox } from './slice-inpaint';
import { getBlob, putBlob } from './slice-db';
import { removeEdgeBackground } from './slice-transparency';
import { vectorizeToSvg } from './slice-vectorize';
import type { SliceAsset } from './slice-types';

/** 从 Blob 解码为可绘制的位图。 */
function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('切图图片加载失败'));
    };
    img.src = url;
  });
}

/** Blob → dataURL，供视觉模型的图片入参使用。 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('切图读取失败'));
    reader.readAsDataURL(blob);
  });
}

/** 取出该资产当前显示的位图；缺失时抛出可展示的错误。 */
async function requireCurrentBlob(asset: SliceAsset): Promise<Blob> {
  const blob = await getBlob(asset.currentBlobKey);
  if (!blob) throw new Error(`「${asset.name || '切图'}」的图片数据已丢失`);
  return blob;
}

/** 单个资产的算法透明化，返回新 Blob key。 */
export async function runLocalTransparent(asset: SliceAsset): Promise<string> {
  const blob = await requireCurrentBlob(asset);
  const img = await loadImage(blob);
  const out = await removeEdgeBackground(img);
  const key = await putBlob(out, 'image/png');
  if (!key) throw new Error('透明化结果写入失败');
  return key;
}

/** 单个资产的算法矢量化，返回 SVG 源码。 */
export async function runLocalSvg(asset: SliceAsset): Promise<string> {
  const blob = await requireCurrentBlob(asset);
  const img = await loadImage(blob);
  return vectorizeToSvg(img, asset.placement.width, asset.placement.height);
}

/**
 * 单个资产的 AI 透明化，返回新 Blob key。
 *
 * 走 letterbox：图片编辑端点只接受固定几档画布尺寸，
 * 直接送任意尺寸的小切图会被拉伸变形。补齐流程已有同一套换算，这里复用。
 */
export async function runAiTransparent(params: {
  asset: SliceAsset;
  model: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { asset, model, signal } = params;
  const blob = await requireCurrentBlob(asset);
  const width = Math.max(1, Math.round(asset.placement.width));
  const height = Math.max(1, Math.round(asset.placement.height));

  const { blob: letterboxed, box, size } = await letterboxToSize(blob);
  const result = await requestAiTransparent({
    model,
    imageBlob: letterboxed,
    size: `${size.width}x${size.height}`,
    signal,
  });
  const restored = await restoreFromLetterbox(result, box, size, width, height);

  const key = await putBlob(restored, 'image/png');
  if (!key) throw new Error('AI 透明结果写入失败');
  return key;
}

/** 单个资产的 AI 重绘 SVG，返回已校验的 SVG 源码。 */
export async function runAiSvg(params: {
  asset: SliceAsset;
  signal?: AbortSignal;
  onRetry?: () => void;
  onStreamStart?: () => void;
  onDelta?: (delta: string, accumulated: string) => void;
}): Promise<string> {
  const { asset, signal, onRetry, onStreamStart, onDelta } = params;
  const blob = await requireCurrentBlob(asset);
  const imageDataUrl = await blobToDataUrl(blob);
  return requestAiSvg({
    imageDataUrl,
    assetName: asset.name || 'ui_asset',
    width: Math.max(1, Math.round(asset.placement.width)),
    height: Math.max(1, Math.round(asset.placement.height)),
    signal,
    onRetry,
    onStreamStart,
    onDelta,
  });
}

/** 批量结果：成功项 + 失败项。失败项单独返回，便于一次性汇总提示。 */
export interface BatchOpResult<T> {
  succeeded: Array<{ id: string; value: T }>;
  failed: Array<{ id: string; name: string; message: string }>;
}

/**
 * 批量执行某个算法操作。
 *
 * 逐个 await 而不是 Promise.all：矢量化与透明化都是 CPU 密集的 canvas 操作，
 * 并发只会争抢主线程、让界面卡死更久，串行反而更快出第一个结果。
 * 单项失败不中断整批 —— 一张图路径过多不该拖累其他图。
 */
export async function runBatchOp<T>(
  assets: SliceAsset[],
  run: (asset: SliceAsset) => Promise<T>,
): Promise<BatchOpResult<T>> {
  const succeeded: Array<{ id: string; value: T }> = [];
  const failed: Array<{ id: string; name: string; message: string }> = [];
  for (const asset of assets) {
    try {
      succeeded.push({ id: asset.id, value: await run(asset) });
    } catch (error) {
      failed.push({
        id: asset.id,
        name: asset.name || '未命名',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { succeeded, failed };
}
