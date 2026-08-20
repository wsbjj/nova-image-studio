// 本地透明化（不消耗 AI 额度）
//
// 移植自 imagetoslice/src/ui/app.js 的 removeEdgeBackground()。
// 透明处理结果由编辑器写入 transparentBlobKey，并保留 originalBlobKey 供还原。
//
// 原理：从切图四边采样估计背景色，然后按与背景色的距离决定 alpha：
//   距离 <= hard(34)  → 完全透明
//   hard < 距离 < soft(82) → 按比例过渡（保留抗锯齿边缘）
//   距离 >= soft      → 完全保留
// 这对纯色/近纯色背景的图标、插画效果好；复杂背景应改用 AI 透明。

import { canvasToBlob } from './slice-crop';
import { averageBackgroundColors, getPixelColor, type SampleColor } from './slice-repair';

/** 完全透明的距离阈值。 */
export const HARD_THRESHOLD = 34;
/** 完全保留的距离阈值；两者之间按比例过渡。 */
export const SOFT_THRESHOLD = 82;

/** RGB 欧氏距离。 */
export function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * 沿四条边采样估计背景色。
 * 步长按短边 1/18 取，保证大图也只采几十个点。
 */
export function sampleEdgeColor(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): SampleColor {
  const samples: SampleColor[] = [];
  const step = Math.max(1, Math.floor(Math.min(width, height) / 18));
  for (let x = 0; x < width; x += step) {
    samples.push(getPixelColor(pixels, width, x, 0));
    samples.push(getPixelColor(pixels, width, x, height - 1));
  }
  for (let y = 0; y < height; y += step) {
    samples.push(getPixelColor(pixels, width, 0, y));
    samples.push(getPixelColor(pixels, width, width - 1, y));
  }
  return averageBackgroundColors(samples);
}

/**
 * 按背景色距离改写 alpha 通道（就地修改并返回）。
 *
 * 已经透明的像素（alpha 0）保持不变；软阈值区间按比例衰减而非直接置 0，
 * 这样图标边缘的抗锯齿像素不会变成硬边锯齿。
 */
export function applyEdgeTransparency(
  pixels: Uint8ClampedArray,
  background: { r: number; g: number; b: number },
  hard = HARD_THRESHOLD,
  soft = SOFT_THRESHOLD,
): Uint8ClampedArray {
  for (let i = 0; i < pixels.length; i += 4) {
    const distance = colorDistance(
      pixels[i],
      pixels[i + 1],
      pixels[i + 2],
      background.r,
      background.g,
      background.b,
    );
    if (distance <= hard) {
      pixels[i + 3] = 0;
    } else if (distance < soft) {
      const ratio = (distance - hard) / (soft - hard);
      pixels[i + 3] = Math.round(pixels[i + 3] * ratio);
    }
    // distance >= soft：完全保留，不动
  }
  return pixels;
}

/**
 * 对一张图执行本地背景移除，返回透明 PNG Blob。
 */
export async function removeEdgeBackground(source: HTMLImageElement | HTMLCanvasElement): Promise<Blob> {
  const width =
    source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const height =
    source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  ctx.drawImage(source, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const background = sampleEdgeColor(imageData.data, canvas.width, canvas.height);
  applyEdgeTransparency(imageData.data, background);
  ctx.putImageData(imageData, 0, 0);

  return canvasToBlob(canvas, 'image/png');
}
