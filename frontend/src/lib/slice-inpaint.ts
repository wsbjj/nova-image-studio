// AI 补齐的图像对齐与合成层
//
// 修的是移植版最影响观感的三个缺陷：
//   A2 返回图尺寸不对齐 —— 未传 size、未做 letterbox 往返，模型返回 1024x1024 被直接当背景存下 → 拉伸错位
//   A3 没有羽化合成     —— 整张替换 → 全局色偏、蒙版外像素被改写
//   A5 覆盖层不外扩     —— 抗锯齿残边留在补齐结果里
//
// 源项目在服务端用 sharp 完成（toOpenAIImageSize + extendWith:'copy' + extract(contentBox)），
// 这里用 canvas 等价实现，因此后端无需改动。
//
// 纯函数（尺寸/坐标/像素运算）与 canvas 包装分离，前者可在 jsdom 下直接单测。

import { canvasToBlob } from './slice-crop';
import { clampNumber } from './slice-geometry';
import { buildInpaintPrompt, requestSliceInpaint } from './slice-ai-client';
import type { SlicePlacement } from './slice-types';

/** 图片编辑端点支持的画布尺寸。 */
export const EDITABLE_SIZES = [
  { width: 1024, height: 1024 },
  { width: 1536, height: 1024 },
  { width: 1024, height: 1536 },
] as const;

export interface Size {
  width: number;
  height: number;
}

/** 源图在 letterbox 画布中的落位。 */
export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 源图 → letterbox 的缩放比 */
  scale: number;
}

// ===== 纯函数：尺寸与坐标 =====

/**
 * 选择宽高比最接近的目标尺寸。
 * 比较的是 log 比值，避免 2:1 与 1:2 因线性差值不对称而选错。
 */
export function pickEditableSize(width: number, height: number): Size {
  const safeW = Math.max(1, width);
  const safeH = Math.max(1, height);
  const target = Math.log(safeW / safeH);
  let best: Size = EDITABLE_SIZES[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const size of EDITABLE_SIZES) {
    const delta = Math.abs(Math.log(size.width / size.height) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = size;
    }
  }
  return { width: best.width, height: best.height };
}

/**
 * 计算源图等比缩放后在 letterbox 画布中的居中落位。
 * 只缩不放：源图小于目标尺寸时保持原尺寸，避免先放大再缩回引入插值损失。
 */
export function computeContentBox(srcWidth: number, srcHeight: number, size: Size): ContentBox {
  const safeW = Math.max(1, srcWidth);
  const safeH = Math.max(1, srcHeight);
  const scale = Math.min(size.width / safeW, size.height / safeH, 1);
  const width = Math.max(1, Math.round(safeW * scale));
  const height = Math.max(1, Math.round(safeH * scale));
  return {
    x: Math.floor((size.width - width) / 2),
    y: Math.floor((size.height - height) / 2),
    width,
    height,
    scale,
  };
}

/**
 * 覆盖层区域外扩：按短边 10% 向外扩，夹取在 [4,16] 像素。
 * 不外扩会把前景的抗锯齿边缘留在补齐结果里，形成一圈残影。
 */
export function padRegion(
  region: SlicePlacement,
  bounds: Size,
  ratio = 0.1,
  minPad = 4,
  maxPad = 16,
): SlicePlacement {
  const pad = clampNumber(
    Math.round(Math.min(region.width, region.height) * ratio),
    minPad,
    maxPad,
    minPad,
  );
  const x = Math.max(0, Math.round(region.x - pad));
  const y = Math.max(0, Math.round(region.y - pad));
  const right = Math.min(bounds.width, Math.round(region.x + region.width + pad));
  const bottom = Math.min(bounds.height, Math.round(region.y + region.height + pad));
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

/** 把源图局部坐标的区域映射到 letterbox 画布坐标。 */
export function mapRegionToLetterbox(region: SlicePlacement, box: ContentBox): SlicePlacement {
  return {
    x: Math.round(box.x + region.x * box.scale),
    y: Math.round(box.y + region.y * box.scale),
    width: Math.max(1, Math.round(region.width * box.scale)),
    height: Math.max(1, Math.round(region.height * box.scale)),
  };
}

/** 羽化半径：短边 0.8%，夹取 [3,12]，与源项目一致。 */
export function featherRadius(width: number, height: number): number {
  return clampNumber(Math.round(Math.min(width, height) * 0.008), 3, 12, 3);
}

// ===== 纯函数：蒙版与合成 =====

/**
 * 某点的羽化 alpha（0–255）。
 *
 * 区域**外**恒为 0 —— 这是"蒙版外像素逐像素不变"的根基。
 * 区域内从边界向内在 radius 距离上从 0 线性升到 255；多区域重叠时取最大值。
 */
export function featherAlphaAt(
  x: number,
  y: number,
  regions: SlicePlacement[],
  radius: number,
): number {
  let best = 0;
  for (const r of regions) {
    if (x < r.x || y < r.y || x >= r.x + r.width || y >= r.y + r.height) continue;
    const dLeft = x - r.x + 0.5;
    const dRight = r.x + r.width - x - 0.5;
    const dTop = y - r.y + 0.5;
    const dBottom = r.y + r.height - y - 0.5;
    const d = Math.min(dLeft, dRight, dTop, dBottom);
    const a = radius <= 0 ? 1 : Math.min(1, d / radius);
    if (a > best) best = a;
  }
  return Math.round(best * 255);
}

/** 生成羽化蒙版的 alpha 平面（长度 = width * height）。 */
export function buildFeatherAlpha(
  width: number,
  height: number,
  regions: SlicePlacement[],
  radius: number,
): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      alpha[y * width + x] = featherAlphaAt(x, y, regions, radius);
    }
  }
  return alpha;
}

/**
 * 按 alpha 平面合成：out = base*(1-a) + result*a。
 *
 * 就地修改 base 并返回它。alpha 为 0 的像素**原样保留**（不做任何算术改写），
 * 这样蒙版外区域与合成前逐位相同，模型的全局色偏无法渗出到蒙版之外。
 */
export function compositePixels(
  base: Uint8ClampedArray,
  result: Uint8ClampedArray,
  alpha: Uint8ClampedArray,
): Uint8ClampedArray {
  for (let i = 0; i < alpha.length; i += 1) {
    const a = alpha[i];
    if (a === 0) continue; // 快路径 + 精确保真
    const p = i * 4;
    if (a === 255) {
      base[p] = result[p];
      base[p + 1] = result[p + 1];
      base[p + 2] = result[p + 2];
      base[p + 3] = result[p + 3];
      continue;
    }
    const w = a / 255;
    const inv = 1 - w;
    base[p] = Math.round(base[p] * inv + result[p] * w);
    base[p + 1] = Math.round(base[p + 1] * inv + result[p + 1] * w);
    base[p + 2] = Math.round(base[p + 2] * inv + result[p + 2] * w);
    base[p + 3] = Math.round(base[p + 3] * inv + result[p + 3] * w);
  }
  return base;
}

// ===== canvas 包装 =====

/** 从 Blob 解码为 HTMLImageElement。 */
export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败'));
    };
    img.src = url;
  });
}

function context2d(canvas: HTMLCanvasElement, readFrequently = false): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', readFrequently ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  return ctx;
}

export interface LetterboxResult {
  blob: Blob;
  box: ContentBox;
  size: Size;
}

/**
 * 把图片放进模型支持的画布尺寸。
 *
 * 留白用**边缘像素拉伸**填充而不是黑边（对应源项目的 extendWith:'copy'）：
 * 黑边会被模型当作画面内容，在边界处生成暗角或误把黑色延伸进重建区域。
 */
export async function letterboxToSize(blob: Blob, size?: Size): Promise<LetterboxResult> {
  const img = await loadImage(blob);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const target = size ?? pickEditableSize(srcW, srcH);
  const box = computeContentBox(srcW, srcH, target);

  const canvas = document.createElement('canvas');
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = context2d(canvas);

  // 先画主体
  ctx.drawImage(img, 0, 0, srcW, srcH, box.x, box.y, box.width, box.height);

  // 再用主体的边缘 1px 条带拉伸填满四周留白
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  if (box.y > 0) ctx.drawImage(canvas, box.x, box.y, box.width, 1, box.x, 0, box.width, box.y);
  if (bottom < target.height) {
    ctx.drawImage(canvas, box.x, bottom - 1, box.width, 1, box.x, bottom, box.width, target.height - bottom);
  }
  if (box.x > 0) ctx.drawImage(canvas, box.x, 0, 1, target.height, 0, 0, box.x, target.height);
  if (right < target.width) {
    ctx.drawImage(canvas, right - 1, 0, 1, target.height, right, 0, target.width - right, target.height);
  }

  return { blob: await canvasToBlob(canvas, 'image/png'), box, size: target };
}

/**
 * 把模型返回的图还原为原始尺寸。
 *
 * 模型可能返回与请求 size 不同的分辨率，所以先按比例换算 contentBox，再裁出并缩回目标尺寸。
 */
export async function restoreFromLetterbox(
  blob: Blob,
  box: ContentBox,
  size: Size,
  targetWidth: number,
  targetHeight: number,
): Promise<Blob> {
  const img = await loadImage(blob);
  const actualW = img.naturalWidth || img.width;
  const actualH = img.naturalHeight || img.height;
  const kx = actualW / size.width;
  const ky = actualH / size.height;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(targetWidth));
  canvas.height = Math.max(1, Math.round(targetHeight));
  const ctx = context2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    img,
    box.x * kx,
    box.y * ky,
    Math.max(1, box.width * kx),
    Math.max(1, box.height * ky),
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvasToBlob(canvas, 'image/png');
}

/** 生成给模型的硬边黑白蒙版：白 = 需要重建。 */
export async function createHardMaskBlob(
  width: number,
  height: number,
  regions: SlicePlacement[],
): Promise<Blob> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = context2d(canvas);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  for (const r of regions) {
    ctx.fillRect(
      Math.round(r.x),
      Math.round(r.y),
      Math.max(1, Math.round(r.width)),
      Math.max(1, Math.round(r.height)),
    );
  }
  return canvasToBlob(canvas, 'image/png');
}

/**
 * 用羽化蒙版把模型输出合成回原图。
 *
 * 返回的图在蒙版之外与 baseBlob 逐像素相同 —— 这正是"不出现全局色偏"的保证。
 */
export async function compositeThroughMask(
  baseBlob: Blob,
  resultBlob: Blob,
  regions: SlicePlacement[],
): Promise<Blob> {
  const [baseImg, resultImg] = await Promise.all([loadImage(baseBlob), loadImage(resultBlob)]);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = width;
  baseCanvas.height = height;
  const baseCtx = context2d(baseCanvas, true);
  baseCtx.drawImage(baseImg, 0, 0);
  const baseData = baseCtx.getImageData(0, 0, width, height);

  // 模型返回尺寸可能不同，先缩放对齐再取像素
  const resultCanvas = document.createElement('canvas');
  resultCanvas.width = width;
  resultCanvas.height = height;
  const resultCtx = context2d(resultCanvas, true);
  resultCtx.imageSmoothingEnabled = true;
  resultCtx.imageSmoothingQuality = 'high';
  resultCtx.drawImage(resultImg, 0, 0, width, height);
  const resultData = resultCtx.getImageData(0, 0, width, height);

  const alpha = buildFeatherAlpha(width, height, regions, featherRadius(width, height));
  compositePixels(baseData.data, resultData.data, alpha);
  baseCtx.putImageData(baseData, 0, 0);

  return canvasToBlob(baseCanvas, 'image/png');
}

// ===== 端到端编排 =====

export interface InpaintRunResult {
  /** 局部合成：只替换蒙版内像素，蒙版外与原图逐位相同 */
  composite: Blob;
  /** 模型原始输出（已还原为原尺寸），供用户比较取舍 */
  raw: Blob;
}

/**
 * 执行一次 AI 补齐的完整管线。
 *
 * 流程：外扩区域 → letterbox 对齐 → 硬边蒙版 → 请求模型 → 还原原尺寸 → 羽化合成。
 *
 * **产出两个结果而不是一个**：源项目的刻意设计。局部合成保真但可能欠自然，
 * AI 原图更自然但可能有全局色偏；哪个更好只有用户看得出来，不替用户决定。
 */
export async function runSliceInpaint(params: {
  model: string;
  /** 待补齐的底图（切图或背景裁剪） */
  baseBlob: Blob;
  /** 底图局部坐标下需要重建的区域（未外扩） */
  regions: SlicePlacement[];
  width: number;
  height: number;
  assetName: string;
  bakedVisuals?: string[];
  signal?: AbortSignal;
}): Promise<InpaintRunResult> {
  const { model, baseBlob, regions, width, height, assetName, bakedVisuals, signal } = params;

  // 1) 外扩，消除前景抗锯齿残边
  const padded = regions.map((r) => padRegion(r, { width, height }));

  // 2) 对齐到模型支持的画布尺寸（边缘像素填充，非黑边）
  const { blob: letterboxed, box, size } = await letterboxToSize(baseBlob);

  // 3) 蒙版与提示词都用 letterbox 坐标，三者严格一致
  const mappedRegions = padded.map((r) => mapRegionToLetterbox(r, box));
  const maskBlob = await createHardMaskBlob(size.width, size.height, mappedRegions);
  const prompt = buildInpaintPrompt(assetName, mappedRegions, {
    bakedVisuals,
    canvasWidth: size.width,
    canvasHeight: size.height,
  });

  // 4) 请求。显式传 size，避免服务端按默认尺寸返回
  const resultBlob = await requestSliceInpaint({
    model,
    imageBlob: letterboxed,
    maskBlob,
    prompt,
    size: `${size.width}x${size.height}`,
    signal,
  });

  // 5) 还原到原始尺寸
  const raw = await restoreFromLetterbox(resultBlob, box, size, width, height);

  // 6) 羽化合成：蒙版外逐位保留原图
  const composite = await compositeThroughMask(baseBlob, raw, padded);

  return { composite, raw };
}

// ===== 画笔蒙版版本（自由笔触，不是矩形） =====

/**
 * 把黑白蒙版放进 letterbox 画布。
 *
 * 与 letterboxToSize 的关键差异：留白填**黑**而不是边缘像素复制。
 * 蒙版里黑 = 不改动，所以留白必须是黑；若复制边缘，白色笔触会被拉伸到画布边缘，
 * 导致模型重建整条边。
 */
export async function letterboxMaskToSize(
  maskBlob: Blob,
  box: ContentBox,
  size: Size,
): Promise<Blob> {
  const img = await loadImage(maskBlob);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = context2d(canvas);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.drawImage(img, box.x, box.y, box.width, box.height);
  return canvasToBlob(canvas, 'image/png');
}

/**
 * 按位图蒙版的亮度合成（白=用模型输出，黑=保留原图）。
 *
 * 羽化用 canvas 的 blur filter 软化蒙版边缘；不支持 filter 的环境退化为硬边，
 * 蒙版外像素不变的保证仍然成立。
 */
export async function compositeThroughMaskBitmap(
  baseBlob: Blob,
  resultBlob: Blob,
  maskBlob: Blob,
  featherPx: number,
): Promise<Blob> {
  const [baseImg, resultImg, maskImg] = await Promise.all([
    loadImage(baseBlob),
    loadImage(resultBlob),
    loadImage(maskBlob),
  ]);
  const width = baseImg.naturalWidth || baseImg.width;
  const height = baseImg.naturalHeight || baseImg.height;

  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = width;
  baseCanvas.height = height;
  const baseCtx = context2d(baseCanvas, true);
  baseCtx.drawImage(baseImg, 0, 0);
  const baseData = baseCtx.getImageData(0, 0, width, height);

  const resultCanvas = document.createElement('canvas');
  resultCanvas.width = width;
  resultCanvas.height = height;
  const resultCtx = context2d(resultCanvas, true);
  resultCtx.imageSmoothingEnabled = true;
  resultCtx.imageSmoothingQuality = 'high';
  resultCtx.drawImage(resultImg, 0, 0, width, height);
  const resultData = resultCtx.getImageData(0, 0, width, height);

  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = width;
  maskCanvas.height = height;
  const maskCtx = context2d(maskCanvas, true);
  maskCtx.fillStyle = '#000';
  maskCtx.fillRect(0, 0, width, height);
  if (featherPx > 0 && 'filter' in maskCtx) {
    maskCtx.filter = `blur(${featherPx}px)`;
  }
  maskCtx.drawImage(maskImg, 0, 0, width, height);
  const maskData = maskCtx.getImageData(0, 0, width, height);

  // 取红通道作为 alpha（蒙版是灰度，三通道等值）
  const alpha = new Uint8ClampedArray(width * height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = maskData.data[i * 4];

  compositePixels(baseData.data, resultData.data, alpha);
  baseCtx.putImageData(baseData, 0, 0);
  return canvasToBlob(baseCanvas, 'image/png');
}

/**
 * 画笔蒙版版本的完整补齐管线（供切图编辑器的「AI 补齐」使用）。
 * 同样产出局部合成与 AI 原图两个结果。
 */
export async function runSliceInpaintWithMask(params: {
  model: string;
  baseBlob: Blob;
  maskBlob: Blob;
  width: number;
  height: number;
  assetName: string;
  bakedVisuals?: string[];
  signal?: AbortSignal;
}): Promise<InpaintRunResult> {
  const { model, baseBlob, maskBlob, width, height, assetName, bakedVisuals, signal } = params;

  const { blob: letterboxed, box, size } = await letterboxToSize(baseBlob);
  const letterboxedMask = await letterboxMaskToSize(maskBlob, box, size);

  // 自由笔触无法用矩形精确描述，提示词里给出内容区范围即可
  const prompt = buildInpaintPrompt(
    assetName,
    [{ x: box.x, y: box.y, width: box.width, height: box.height }],
    { bakedVisuals, canvasWidth: size.width, canvasHeight: size.height },
  );

  const resultBlob = await requestSliceInpaint({
    model,
    imageBlob: letterboxed,
    maskBlob: letterboxedMask,
    prompt,
    size: `${size.width}x${size.height}`,
    signal,
  });

  const raw = await restoreFromLetterbox(resultBlob, box, size, width, height);
  const composite = await compositeThroughMaskBitmap(baseBlob, raw, maskBlob, featherRadius(width, height));
  return { composite, raw };
}
