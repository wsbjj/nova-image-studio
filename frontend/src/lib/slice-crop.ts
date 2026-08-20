// 切图重裁剪层
//
// 这里修的是移植版最致命的缺陷：切图框被移动/缩放后，placement 变了但图片数据没变，
// 画布用 object-fit: fill 拉伸旧裁剪充数，导出的 PNG 与框选区域完全对不上。
// 对应源项目 imagetoslice/src/ui/app.js 的 updateSliceAssetCrop()，含版本守卫防止异步竞态。

import { getSliceRadii, isZeroRadii } from './slice-geometry';
import { putBlob } from './slice-db';
import type { SliceAsset, SlicePlacement, SliceRadii, SliceScreen } from './slice-types';

/** canvas.toBlob 的 Promise 包装。 */
export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('canvas.toBlob 返回空'));
    }, type);
  });
}

/**
 * 在 canvas 上描出圆角矩形路径。
 * 优先用 ctx.roundRect（Chrome 99+ / Safari 16+），否则退回 arcTo 手绘。
 */
function traceRoundedRect(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  radii: SliceRadii,
): void {
  // 逐角再夹一次：placement 可能在调用链上被改小，radii 却还是旧值
  const limit = Math.min(width, height) / 2;
  const tl = Math.max(0, Math.min(radii.topLeft, limit));
  const tr = Math.max(0, Math.min(radii.topRight, limit));
  const br = Math.max(0, Math.min(radii.bottomRight, limit));
  const bl = Math.max(0, Math.min(radii.bottomLeft, limit));

  const maybeRoundRect = (ctx as CanvasRenderingContext2D & {
    roundRect?: (x: number, y: number, w: number, h: number, radii: number[]) => void;
  }).roundRect;

  ctx.beginPath();
  if (typeof maybeRoundRect === 'function') {
    maybeRoundRect.call(ctx, 0, 0, width, height, [tl, tr, br, bl]);
    return;
  }

  ctx.moveTo(tl, 0);
  ctx.lineTo(width - tr, 0);
  ctx.arcTo(width, 0, width, tr, tr);
  ctx.lineTo(width, height - br);
  ctx.arcTo(width, height, width - br, height, br);
  ctx.lineTo(bl, height);
  ctx.arcTo(0, height, 0, height - bl, bl);
  ctx.lineTo(0, tl);
  ctx.arcTo(0, 0, tl, 0, tl);
  ctx.closePath();
}

/**
 * 按 placement 从源图裁剪，并应用四角圆角，返回 PNG Blob。
 *
 * 圆角以 clip 实现，圆角外区域为透明像素 —— 这才让「圆角」成为真功能：
 * 移植版只把数字存进 manifest，导出的 PNG 四角仍是方的。
 */
export async function renderSliceBlob(
  source: HTMLImageElement | HTMLCanvasElement,
  placement: SlicePlacement,
  radii?: SliceRadii | null,
): Promise<Blob> {
  const width = Math.max(1, Math.round(placement.width));
  const height = Math.max(1, Math.round(placement.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');

  const effectiveRadii = radii ?? getSliceRadii({ placement });
  if (!isZeroRadii(effectiveRadii)) {
    traceRoundedRect(ctx, width, height, effectiveRadii);
    ctx.clip();
  }

  ctx.drawImage(
    source,
    Math.max(0, Math.round(placement.x)),
    Math.max(0, Math.round(placement.y)),
    width,
    height,
    0,
    0,
    width,
    height,
  );

  return canvasToBlob(canvas, 'image/png');
}

// ===== 版本守卫 =====
//
// 用户可以在上一次重裁剪的 await 还没回来时又拖一次。没有守卫的话，
// 先发起的（较慢的）请求会后落地，把图片写成中间状态。
// 每个 asset 一个自增版本号，异步回来后比对，过期结果直接丢弃。

const cropVersions = new Map<string, number>();

/** 领取一个新版本号，调用方在 await 之后用 isCropVersionCurrent 校验。 */
export function nextCropVersion(assetId: string): number {
  const version = (cropVersions.get(assetId) || 0) + 1;
  cropVersions.set(assetId, version);
  return version;
}

/** 该版本是否仍是最新的一次请求。 */
export function isCropVersionCurrent(assetId: string, version: number): boolean {
  return cropVersions.get(assetId) === version;
}

/** 资产被删除时清掉版本号，避免 Map 无限增长。 */
export function forgetCropVersion(assetId: string): void {
  cropVersions.delete(assetId);
}

/** 重裁剪一个资产后需要写回的字段。 */
export interface RecropPatch {
  originalBlobKey: string;
  currentBlobKey: string;
  transparentBlobKey: null;
  aiTransparentBlobKey: null;
  transparent: false;
  aiTransparent: false;
  aiCompleted: false;
  repairBlobKey: null;
}

/**
 * 按当前 placement / radii 重新裁剪一个资产。
 *
 * 返回 null 表示这次结果应当被丢弃：要么资产在 await 期间又被调整（版本过期），
 * 要么写入 IndexedDB 失败。调用方据此跳过写回。
 *
 * 派生状态一并重置（透明 / AI 补齐 / 修补预览），因为它们都是基于旧区域算出来的。
 * 这与源项目 updateSliceAssetCrop 的行为一致。
 */
export async function recropAsset(
  source: HTMLImageElement | HTMLCanvasElement,
  asset: Pick<SliceAsset, 'id' | 'placement'> & { radii?: SliceRadii | null; radius?: number },
  screen: SliceScreen,
): Promise<RecropPatch | null> {
  const version = nextCropVersion(asset.id);
  const radii = getSliceRadii(asset, screen);

  const blob = await renderSliceBlob(source, asset.placement, radii);
  if (!isCropVersionCurrent(asset.id, version)) return null;

  const key = await putBlob(blob, 'image/png');
  if (!key) return null;
  if (!isCropVersionCurrent(asset.id, version)) return null;

  return {
    originalBlobKey: key,
    currentBlobKey: key,
    transparentBlobKey: null,
    aiTransparentBlobKey: null,
    transparent: false,
    aiTransparent: false,
    aiCompleted: false,
    repairBlobKey: null,
  };
}

/**
 * 生成工作区缩略图（等比缩放，长边不超过 maxSize）。
 *
 * 移植版从不写 thumbnailBlobKey，历史列表里每张卡片都是占位剪刀图标。
 */
export async function renderThumbnailBlob(
  source: HTMLImageElement | HTMLCanvasElement,
  maxSize = 320,
): Promise<Blob> {
  const srcW =
    source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const srcH =
    source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;
  const scale = Math.min(maxSize / Math.max(1, srcW), maxSize / Math.max(1, srcH), 1);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'image/png');
}
