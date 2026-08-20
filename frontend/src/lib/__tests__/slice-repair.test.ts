import { describe, expect, it } from 'vitest';

import {
  averageBackgroundColors,
  averageColors,
  collectRectColors,
  getPixelColor,
  mixColors,
  paintEdgeBlendPatch,
  samplePlacementEdgeStats,
  type SampleColor,
} from '@/lib/slice-repair';

/** 构造一张纯色 RGBA 图。 */
function solidImage(width: number, height: number, r: number, g: number, b: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

function color(r: number, g: number, b: number): SampleColor {
  return {
    r,
    g,
    b,
    luma: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    saturation: Math.max(r, g, b) - Math.min(r, g, b),
  };
}

describe('getPixelColor', () => {
  it('reads a pixel and derives luma/saturation', () => {
    const pixels = solidImage(2, 2, 10, 20, 30);
    const c = getPixelColor(pixels, 2, 1, 1);
    expect([c.r, c.g, c.b]).toEqual([10, 20, 30]);
    expect(c.saturation).toBe(20);
    expect(c.luma).toBeCloseTo(0.2126 * 10 + 0.7152 * 20 + 0.0722 * 30, 6);
  });
});

describe('mixColors', () => {
  it('interpolates and clamps the weight', () => {
    const a = color(0, 0, 0);
    const b = color(100, 200, 40);
    expect(mixColors(a, b, 0).r).toBe(0);
    expect(mixColors(a, b, 1).g).toBe(200);
    expect(mixColors(a, b, 0.5).g).toBe(100);
    // 越界权重被夹取，而不是外推出界外颜色
    expect(mixColors(a, b, -5).r).toBe(0);
    expect(mixColors(a, b, 99).b).toBe(40);
  });
});

describe('averageColors', () => {
  it('averages samples', () => {
    const avg = averageColors([color(0, 0, 0), color(100, 100, 100)]);
    expect(avg.r).toBe(50);
  });

  it('returns the fallback for an empty set', () => {
    const fb = color(1, 2, 3);
    expect(averageColors([], fb)).toEqual(fb);
  });
});

describe('averageBackgroundColors', () => {
  it('biases toward low-saturation samples', () => {
    // 少量高饱和前景像素（纯红）不应主导结果
    const samples = [
      ...Array.from({ length: 20 }, () => color(200, 200, 200)),
      ...Array.from({ length: 4 }, () => color(255, 0, 0)),
    ];
    const bg = averageBackgroundColors(samples);
    expect(bg.r).toBeGreaterThan(150);
    expect(bg.g).toBeGreaterThan(150);
    expect(bg.b).toBeGreaterThan(150);
  });

  it('returns the fallback for an empty set', () => {
    const fb = color(9, 9, 9);
    expect(averageBackgroundColors([], fb)).toEqual(fb);
  });
});

describe('collectRectColors', () => {
  it('samples inside the rect and caps the sample count', () => {
    const pixels = solidImage(200, 200, 5, 5, 5);
    const samples = collectRectColors(pixels, 200, { x: 0, y: 0, width: 200, height: 200 });
    expect(samples.length).toBeGreaterThan(0);
    // 抽样步长限制总数量级，不应逐像素取 40000 个
    expect(samples.length).toBeLessThan(1000);
    expect(samples[0].r).toBe(5);
  });

  it('returns nothing for a degenerate rect', () => {
    const pixels = solidImage(10, 10, 0, 0, 0);
    expect(collectRectColors(pixels, 10, { x: 0, y: 0, width: 0, height: 5 })).toEqual([]);
    expect(collectRectColors(pixels, 10, { x: 0, y: 0, width: 5, height: 0 })).toEqual([]);
  });
});

describe('samplePlacementEdgeStats', () => {
  it('picks up the surrounding colour on a uniform image', () => {
    const pixels = solidImage(100, 100, 120, 130, 140);
    const stats = samplePlacementEdgeStats(pixels, 100, 100, { x: 30, y: 30, width: 40, height: 40 });
    expect(stats.color.r).toBeCloseTo(120, 0);
    expect(stats.sides.top.g).toBeCloseTo(130, 0);
    expect(stats.sides.bottom.b).toBeCloseTo(140, 0);
  });

  it('does not sample the slice interior', () => {
    // 外圈灰、内部一块纯红：补丁颜色应来自灰色外圈，而不是被抠掉的红色前景
    const width = 100;
    const height = 100;
    const pixels = solidImage(width, height, 200, 200, 200);
    for (let y = 30; y < 70; y += 1) {
      for (let x = 30; x < 70; x += 1) {
        const i = (y * width + x) * 4;
        pixels[i] = 255;
        pixels[i + 1] = 0;
        pixels[i + 2] = 0;
      }
    }
    const stats = samplePlacementEdgeStats(pixels, width, height, { x: 30, y: 30, width: 40, height: 40 });
    expect(stats.color.r).toBeCloseTo(200, 0);
    expect(stats.color.g).toBeCloseTo(200, 0);
  });

  it('survives a placement flush against the image edge', () => {
    // 左上角贴边时，top/left 色带宽度为 0，不能崩也不能产生 NaN
    const pixels = solidImage(50, 50, 80, 90, 100);
    const stats = samplePlacementEdgeStats(pixels, 50, 50, { x: 0, y: 0, width: 20, height: 20 });
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
      expect(Number.isFinite(stats.sides[side].r)).toBe(true);
      expect(Number.isFinite(stats.sides[side].g)).toBe(true);
      expect(Number.isFinite(stats.sides[side].b)).toBe(true);
    }
  });

  it('clamps an out-of-bounds placement', () => {
    const pixels = solidImage(40, 40, 10, 10, 10);
    const stats = samplePlacementEdgeStats(pixels, 40, 40, {
      x: -50,
      y: -50,
      width: 999,
      height: 999,
    });
    expect(Number.isFinite(stats.color.r)).toBe(true);
  });
});

describe('paintEdgeBlendPatch', () => {
  it('fills every pixel opaque, blending between the four sides', () => {
    const width = 8;
    const height = 6;
    const data = new Uint8ClampedArray(width * height * 4);
    const ctx = {
      createImageData: () => ({ data, width, height }),
      putImageData: () => {},
    } as unknown as CanvasRenderingContext2D;

    paintEdgeBlendPatch(ctx, width, height, {
      color: color(128, 128, 128),
      sides: {
        top: color(0, 0, 0),
        right: color(255, 255, 255),
        bottom: color(255, 255, 255),
        left: color(0, 0, 0),
      },
    });

    // 全部像素不透明，且落在两端颜色之间
    for (let i = 0; i < width * height; i += 1) {
      expect(data[i * 4 + 3]).toBe(255);
      expect(data[i * 4]).toBeGreaterThanOrEqual(0);
      expect(data[i * 4]).toBeLessThanOrEqual(255);
    }
    // 左上角偏黑、右下角偏白（沿混合方向单调）
    const topLeft = data[0];
    const bottomRight = data[(width * height - 1) * 4];
    expect(topLeft).toBeLessThan(bottomRight);
  });

  it('handles a 1x1 patch without dividing by zero', () => {
    const data = new Uint8ClampedArray(4);
    const ctx = {
      createImageData: () => ({ data, width: 1, height: 1 }),
      putImageData: () => {},
    } as unknown as CanvasRenderingContext2D;
    paintEdgeBlendPatch(ctx, 1, 1, {
      color: color(10, 20, 30),
      sides: { top: color(10, 20, 30), right: color(10, 20, 30), bottom: color(10, 20, 30), left: color(10, 20, 30) },
    });
    expect(Number.isNaN(data[0])).toBe(false);
    expect(data[3]).toBe(255);
  });
});
