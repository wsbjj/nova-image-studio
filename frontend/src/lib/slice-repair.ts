// 切图边缘混合补丁（本地，零 AI 成本）
//
// 移植自 imagetoslice/src/ui/services/slice-repair.js + image-color-utils.js。
// 用途：把切图从源图上"抠掉"之后，那块区域该长什么样？
// 这里对切图四周紧邻的像素带取色，按双线性混合画一块补丁填进去，
// 让用户在不花 AI 额度的前提下判断框选是否合理（对应「挖洞」查看模式）。
//
// 注意这只是"看起来合理"的近似，不是真正的图像修补 —— 真修补走 AI 补齐（P3）。

import { canvasToBlob } from './slice-crop';
import { clampNumber } from './slice-geometry';
import type { SlicePlacement } from './slice-types';

/** 采样得到的一个颜色。luma/saturation 供背景色筛选使用。 */
export interface SampleColor {
  r: number;
  g: number;
  b: number;
  luma: number;
  saturation: number;
}

/** 兜底色：接近浅灰白的界面底色，避免采样为空时画出纯黑。 */
const FALLBACK_COLOR: SampleColor = { r: 244, g: 246, b: 250, luma: 246, saturation: 6 };

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 从 RGBA 数组中读一个像素。 */
export function getPixelColor(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): SampleColor {
  const index = (y * width + x) * 4;
  const r = pixels[index];
  const g = pixels[index + 1];
  const b = pixels[index + 2];
  return {
    r,
    g,
    b,
    luma: luma(r, g, b),
    saturation: Math.max(r, g, b) - Math.min(r, g, b),
  };
}

/** 线性插值两个颜色。weight=0 取 a，=1 取 b。 */
export function mixColors(a: SampleColor, b: SampleColor, weight = 0.5): SampleColor {
  const amount = clampNumber(weight, 0, 1, 0.5);
  const inverse = 1 - amount;
  const r = a.r * inverse + b.r * amount;
  const g = a.g * inverse + b.g * amount;
  const bb = a.b * inverse + b.b * amount;
  return { r, g, b: bb, luma: luma(r, g, bb), saturation: Math.max(r, g, bb) - Math.min(r, g, bb) };
}

/** 简单平均。 */
export function averageColors(
  samples: SampleColor[],
  fallback: SampleColor = FALLBACK_COLOR,
): SampleColor {
  if (samples.length === 0) return fallback;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const s of samples) {
    r += s.r;
    g += s.g;
    b += s.b;
  }
  const n = samples.length;
  const ar = r / n;
  const ag = g / n;
  const ab = b / n;
  return { r: ar, g: ag, b: ab, luma: luma(ar, ag, ab), saturation: Math.max(ar, ag, ab) - Math.min(ar, ag, ab) };
}

/**
 * 估计"背景色"：先按饱和度取低饱和的那部分（前景插画/图标通常更艳），
 * 再按亮度裁掉两端极值，最后取平均。这样能避开紧贴切图边缘的高饱和前景像素。
 */
export function averageBackgroundColors(
  samples: SampleColor[],
  fallback: SampleColor = FALLBACK_COLOR,
): SampleColor {
  if (samples.length === 0) return fallback;
  const bySaturation = [...samples].sort((a, b) => a.saturation - b.saturation);
  const lowSaturationCount = Math.max(6, Math.ceil(bySaturation.length * 0.68));
  const candidates = bySaturation.slice(0, lowSaturationCount).sort((a, b) => a.luma - b.luma);
  const start = Math.floor(candidates.length * 0.12);
  const end = Math.max(start + 1, Math.ceil(candidates.length * 0.88));
  return averageColors(candidates.slice(start, end), fallback);
}

/** 在给定矩形内按步长抽样，最多约 160 个点，避免大区域逐像素读取。 */
export function collectRectColors(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  rect: { x: number; y: number; width: number; height: number },
): SampleColor[] {
  const w = Math.max(0, Math.floor(rect.width));
  const h = Math.max(0, Math.floor(rect.height));
  if (!w || !h) return [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 160)));
  const samples: SampleColor[] = [];
  for (let row = 0; row < h; row += step) {
    for (let col = 0; col < w; col += step) {
      samples.push(
        getPixelColor(pixels, imageWidth, Math.floor(rect.x) + col, Math.floor(rect.y) + row),
      );
    }
  }
  return samples;
}

export interface EdgeStats {
  color: SampleColor;
  sides: { top: SampleColor; right: SampleColor; bottom: SampleColor; left: SampleColor };
}

/**
 * 采样 placement 四周紧邻的像素带（宽度取短边 12%，夹取 2–10px）。
 * 注意采的是切图**外侧**的像素——那才是"背景"，切图内部是要被抠掉的前景。
 */
export function samplePlacementEdgeStats(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  placement: SlicePlacement,
): EdgeStats {
  const x = clampNumber(Math.round(placement.x), 0, Math.max(0, imageWidth - 1), 0);
  const y = clampNumber(Math.round(placement.y), 0, Math.max(0, imageHeight - 1), 0);
  const width = clampNumber(Math.round(placement.width), 1, Math.max(1, imageWidth - x), 1);
  const height = clampNumber(Math.round(placement.height), 1, Math.max(1, imageHeight - y), 1);
  const band = Math.max(2, Math.min(10, Math.round(Math.min(width, height) * 0.12)));

  const sideSamples = {
    top: collectRectColors(pixels, imageWidth, {
      x,
      y: Math.max(0, y - band),
      width,
      height: Math.min(band, y),
    }),
    right: collectRectColors(pixels, imageWidth, {
      x: Math.min(imageWidth - 1, x + width),
      y,
      width: Math.min(band, imageWidth - x - width),
      height,
    }),
    bottom: collectRectColors(pixels, imageWidth, {
      x,
      y: Math.min(imageHeight - 1, y + height),
      width,
      height: Math.min(band, imageHeight - y - height),
    }),
    left: collectRectColors(pixels, imageWidth, {
      x: Math.max(0, x - band),
      y,
      width: Math.min(band, x),
      height,
    }),
  };

  const all = [
    ...sideSamples.top,
    ...sideSamples.right,
    ...sideSamples.bottom,
    ...sideSamples.left,
  ];
  const color = averageBackgroundColors(all);
  return {
    color,
    sides: {
      top: averageBackgroundColors(sideSamples.top, color),
      right: averageBackgroundColors(sideSamples.right, color),
      bottom: averageBackgroundColors(sideSamples.bottom, color),
      left: averageBackgroundColors(sideSamples.left, color),
    },
  };
}

/**
 * 画补丁：水平方向按 left→right 混合，垂直方向按 top→bottom 混合，两者再按 0.46 权重合并；
 * 越靠中心越向整体平均色靠拢（centerWeight 上限 0.32），避免四角颜色互相拉扯出十字条纹。
 */
export function paintEdgeBlendPatch(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  stats: EdgeStats,
): void {
  const imageData = ctx.createImageData(width, height);
  const pixels = imageData.data;
  const { sides, color: center } = stats;

  for (let y = 0; y < height; y += 1) {
    const verticalAmount = height <= 1 ? 0.5 : y / (height - 1);
    for (let x = 0; x < width; x += 1) {
      const horizontalAmount = width <= 1 ? 0.5 : x / (width - 1);
      const horizontal = mixColors(sides.left, sides.right, horizontalAmount);
      const vertical = mixColors(sides.top, sides.bottom, verticalAmount);
      const edgeBias = Math.min(x, y, width - 1 - x, height - 1 - y) / Math.max(width, height);
      const centerWeight = clampNumber(edgeBias * 1.35, 0, 0.32, 0);
      const blended = mixColors(mixColors(horizontal, vertical, 0.46), center, centerWeight);
      const index = (y * width + x) * 4;
      pixels[index] = Math.round(blended.r);
      pixels[index + 1] = Math.round(blended.g);
      pixels[index + 2] = Math.round(blended.b);
      pixels[index + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * 为单个切图生成边缘混合补丁 Blob（尺寸与 placement 一致）。
 * 调用方把它盖在源图对应位置上，即得到"抠掉这块切图之后"的预览。
 */
export async function createSliceRepairPatch(
  source: HTMLImageElement | HTMLCanvasElement,
  placement: SlicePlacement,
): Promise<Blob> {
  const naturalWidth =
    source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const naturalHeight =
    source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;

  // 先把源图整张画到一个可读像素的 canvas 上，再采样四周色带
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = naturalWidth;
  sampleCanvas.height = naturalHeight;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });
  if (!sampleCtx) throw new Error('Canvas 2D 上下文不可用');
  sampleCtx.drawImage(source, 0, 0, naturalWidth, naturalHeight);
  const full = sampleCtx.getImageData(0, 0, naturalWidth, naturalHeight);
  const stats = samplePlacementEdgeStats(full.data, naturalWidth, naturalHeight, placement);

  const patchWidth = Math.max(1, Math.round(placement.width));
  const patchHeight = Math.max(1, Math.round(placement.height));
  const canvas = document.createElement('canvas');
  canvas.width = patchWidth;
  canvas.height = patchHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  paintEdgeBlendPatch(ctx, patchWidth, patchHeight, stats);

  return canvasToBlob(canvas, 'image/png');
}

/**
 * 生成整张"挖洞图"：源图 + 所有指定区域盖上边缘混合补丁。
 * 一次性算完整张，避免每个切图一个 <img> 叠加导致的层数爆炸。
 */
export async function createRepairedPreviewBlob(
  source: HTMLImageElement | HTMLCanvasElement,
  placements: SlicePlacement[],
): Promise<Blob> {
  const naturalWidth =
    source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const naturalHeight =
    source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;

  const canvas = document.createElement('canvas');
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  ctx.drawImage(source, 0, 0, naturalWidth, naturalHeight);

  // 采样必须基于**原始**像素：若边画边采，后画的补丁会把先画的补丁当成"背景"，误差逐块累积
  const original = ctx.getImageData(0, 0, naturalWidth, naturalHeight);

  for (const placement of placements) {
    const w = Math.max(1, Math.round(placement.width));
    const h = Math.max(1, Math.round(placement.height));
    const stats = samplePlacementEdgeStats(original.data, naturalWidth, naturalHeight, placement);
    const patch = document.createElement('canvas');
    patch.width = w;
    patch.height = h;
    const patchCtx = patch.getContext('2d');
    if (!patchCtx) continue;
    paintEdgeBlendPatch(patchCtx, w, h, stats);
    ctx.drawImage(patch, Math.round(placement.x), Math.round(placement.y));
  }

  return canvasToBlob(canvas, 'image/png');
}
