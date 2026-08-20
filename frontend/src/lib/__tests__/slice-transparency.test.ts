import { describe, expect, it } from 'vitest';

import {
  HARD_THRESHOLD,
  SOFT_THRESHOLD,
  applyEdgeTransparency,
  colorDistance,
  sampleEdgeColor,
} from '@/lib/slice-transparency';

/** 构造一张纯色 RGBA 图。 */
function solid(width: number, height: number, r: number, g: number, b: number, a = 255) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = a;
  }
  return pixels;
}

function setPixel(
  pixels: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
) {
  const i = (y * width + x) * 4;
  pixels[i] = r;
  pixels[i + 1] = g;
  pixels[i + 2] = b;
}

function alphaAt(pixels: Uint8ClampedArray, width: number, x: number, y: number) {
  return pixels[(y * width + x) * 4 + 3];
}

describe('colorDistance', () => {
  it('is zero for identical colours and symmetric', () => {
    expect(colorDistance(10, 20, 30, 10, 20, 30)).toBe(0);
    expect(colorDistance(0, 0, 0, 3, 4, 0)).toBe(5);
    expect(colorDistance(3, 4, 0, 0, 0, 0)).toBe(5);
  });
});

describe('sampleEdgeColor', () => {
  it('reads the border colour, not the centre', () => {
    // 边框白、中心纯红：背景色应判为白
    const w = 40;
    const h = 40;
    const pixels = solid(w, h, 255, 255, 255);
    for (let y = 10; y < 30; y += 1) {
      for (let x = 10; x < 30; x += 1) setPixel(pixels, w, x, y, 255, 0, 0);
    }
    const bg = sampleEdgeColor(pixels, w, h);
    expect(bg.r).toBeCloseTo(255, 0);
    expect(bg.g).toBeCloseTo(255, 0);
    expect(bg.b).toBeCloseTo(255, 0);
  });

  it('handles a 1x1 image without dividing by zero', () => {
    const bg = sampleEdgeColor(solid(1, 1, 12, 34, 56), 1, 1);
    expect(Number.isFinite(bg.r)).toBe(true);
  });
});

describe('applyEdgeTransparency', () => {
  it('erases pixels matching the background', () => {
    const pixels = solid(2, 2, 250, 250, 250);
    applyEdgeTransparency(pixels, { r: 250, g: 250, b: 250 });
    expect(Array.from(pixels).filter((_, i) => i % 4 === 3).every((a) => a === 0)).toBe(true);
  });

  it('keeps pixels far from the background fully opaque', () => {
    const w = 1;
    const pixels = solid(w, 1, 255, 0, 0);
    applyEdgeTransparency(pixels, { r: 255, g: 255, b: 255 });
    expect(alphaAt(pixels, w, 0, 0)).toBe(255);
  });

  it('ramps alpha in the soft band instead of hard-cutting', () => {
    // 距离落在 hard 与 soft 之间 → 部分透明，保住抗锯齿边缘
    const mid = (HARD_THRESHOLD + SOFT_THRESHOLD) / 2; // ≈58
    const delta = Math.round(mid / Math.sqrt(3));
    const pixels = solid(1, 1, delta, delta, delta);
    applyEdgeTransparency(pixels, { r: 0, g: 0, b: 0 });
    const a = alphaAt(pixels, 1, 0, 0);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
  });

  it('respects the exact threshold boundaries', () => {
    // 恰好等于 hard → 全透明
    const atHard = solid(1, 1, HARD_THRESHOLD, 0, 0);
    applyEdgeTransparency(atHard, { r: 0, g: 0, b: 0 });
    expect(alphaAt(atHard, 1, 0, 0)).toBe(0);

    // 恰好等于 soft → 完全保留
    const atSoft = solid(1, 1, SOFT_THRESHOLD, 0, 0);
    applyEdgeTransparency(atSoft, { r: 0, g: 0, b: 0 });
    expect(alphaAt(atSoft, 1, 0, 0)).toBe(255);
  });

  it('scales existing alpha rather than overwriting it', () => {
    // 半透明像素落在软区间时，结果应基于原 alpha 缩放
    const mid = (HARD_THRESHOLD + SOFT_THRESHOLD) / 2;
    const delta = Math.round(mid / Math.sqrt(3));
    const pixels = solid(1, 1, delta, delta, delta, 100);
    applyEdgeTransparency(pixels, { r: 0, g: 0, b: 0 });
    expect(alphaAt(pixels, 1, 0, 0)).toBeLessThanOrEqual(100);
  });

  it('leaves a subject intact while clearing its background', () => {
    // 端到端：白底 + 中心红块 → 红块保留，白底透明
    const w = 20;
    const h = 20;
    const pixels = solid(w, h, 255, 255, 255);
    for (let y = 8; y < 12; y += 1) {
      for (let x = 8; x < 12; x += 1) setPixel(pixels, w, x, y, 200, 10, 10);
    }
    const bg = sampleEdgeColor(pixels, w, h);
    applyEdgeTransparency(pixels, bg);
    expect(alphaAt(pixels, w, 0, 0)).toBe(0); // 角落背景
    expect(alphaAt(pixels, w, 9, 9)).toBe(255); // 主体
  });
});
