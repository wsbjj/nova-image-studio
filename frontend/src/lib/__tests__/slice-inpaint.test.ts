import { describe, expect, it } from 'vitest';

import {
  buildFeatherAlpha,
  compositePixels,
  computeContentBox,
  featherAlphaAt,
  featherRadius,
  mapRegionToLetterbox,
  padRegion,
  pickEditableSize,
} from '@/lib/slice-inpaint';
import type { SlicePlacement } from '@/lib/slice-types';

function rect(x: number, y: number, width: number, height: number): SlicePlacement {
  return { x, y, width, height };
}

describe('pickEditableSize', () => {
  it('picks square for square-ish input', () => {
    expect(pickEditableSize(500, 500)).toEqual({ width: 1024, height: 1024 });
    expect(pickEditableSize(800, 780)).toEqual({ width: 1024, height: 1024 });
  });

  it('picks landscape for wide input and portrait for tall input', () => {
    expect(pickEditableSize(1600, 900)).toEqual({ width: 1536, height: 1024 });
    expect(pickEditableSize(750, 1334)).toEqual({ width: 1024, height: 1536 });
  });

  it('is symmetric for reciprocal aspect ratios', () => {
    // 用 log 比值而非线性差值，2:1 与 1:2 必须各自选到对应方向
    expect(pickEditableSize(2000, 1000)).toEqual({ width: 1536, height: 1024 });
    expect(pickEditableSize(1000, 2000)).toEqual({ width: 1024, height: 1536 });
  });

  it('survives degenerate input', () => {
    expect(pickEditableSize(0, 0)).toEqual({ width: 1024, height: 1024 });
  });
});

describe('computeContentBox', () => {
  it('centres the scaled source inside the canvas', () => {
    const box = computeContentBox(750, 1334, { width: 1024, height: 1536 });
    expect(box.width).toBeLessThanOrEqual(1024);
    expect(box.height).toBeLessThanOrEqual(1536);
    // 等比：宽高比保持
    expect(box.width / box.height).toBeCloseTo(750 / 1334, 2);
    // 居中
    expect(box.x).toBe(Math.floor((1024 - box.width) / 2));
    expect(box.y).toBe(Math.floor((1536 - box.height) / 2));
  });

  it('does not upscale a small source', () => {
    // 只缩不放：避免先放大再缩回引入插值损失
    const box = computeContentBox(200, 200, { width: 1024, height: 1024 });
    expect(box.scale).toBe(1);
    expect(box.width).toBe(200);
    expect(box.height).toBe(200);
  });

  it('fits an oversized source', () => {
    const box = computeContentBox(4000, 2000, { width: 1536, height: 1024 });
    expect(box.width).toBe(1536);
    expect(box.height).toBe(768);
    expect(box.y).toBe(128);
  });
});

describe('padRegion', () => {
  it('expands by 10% of the short side, clamped to [4,16]', () => {
    // 短边 100 → 10px
    expect(padRegion(rect(50, 50, 200, 100), { width: 1000, height: 1000 })).toEqual(
      rect(40, 40, 220, 120),
    );
    // 短边 20 → 2px，被夹到下限 4
    expect(padRegion(rect(50, 50, 20, 20), { width: 1000, height: 1000 })).toEqual(
      rect(46, 46, 28, 28),
    );
    // 短边 1000 → 100px，被夹到上限 16
    expect(padRegion(rect(200, 200, 1000, 1000), { width: 5000, height: 5000 })).toEqual(
      rect(184, 184, 1032, 1032),
    );
  });

  it('clamps to the bounds instead of going negative', () => {
    const out = padRegion(rect(0, 0, 100, 100), { width: 120, height: 120 });
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.x + out.width).toBeLessThanOrEqual(120);
    expect(out.y + out.height).toBeLessThanOrEqual(120);
  });
});

describe('mapRegionToLetterbox', () => {
  it('applies the offset and scale', () => {
    const box = { x: 100, y: 50, width: 800, height: 400, scale: 0.5 };
    expect(mapRegionToLetterbox(rect(20, 40, 100, 60), box)).toEqual(rect(110, 70, 50, 30));
  });

  it('never produces a zero-sized region', () => {
    const box = { x: 0, y: 0, width: 10, height: 10, scale: 0.01 };
    const out = mapRegionToLetterbox(rect(0, 0, 10, 10), box);
    expect(out.width).toBeGreaterThanOrEqual(1);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });
});

describe('featherRadius', () => {
  it('is 0.8% of the short side clamped to [3,12]', () => {
    expect(featherRadius(100, 100)).toBe(3); // 0.8 → 下限
    expect(featherRadius(1000, 1000)).toBe(8);
    expect(featherRadius(5000, 5000)).toBe(12); // 40 → 上限
  });
});

describe('featherAlphaAt', () => {
  const regions = [rect(10, 10, 40, 40)];

  it('is exactly 0 everywhere outside the regions', () => {
    // 这是"蒙版外像素零改动"的第一道保证
    for (const [x, y] of [[0, 0], [9, 20], [50, 20], [20, 9], [20, 50], [99, 99]]) {
      expect(featherAlphaAt(x, y, regions, 8)).toBe(0);
    }
  });

  it('reaches full opacity deep inside', () => {
    expect(featherAlphaAt(30, 30, regions, 8)).toBe(255);
  });

  it('ramps up from the boundary inward', () => {
    const atEdge = featherAlphaAt(10, 30, regions, 8);
    const nearEdge = featherAlphaAt(13, 30, regions, 8);
    const inner = featherAlphaAt(18, 30, regions, 8);
    expect(atEdge).toBeLessThan(nearEdge);
    expect(nearEdge).toBeLessThan(inner);
    expect(inner).toBe(255);
  });

  it('takes the maximum across overlapping regions', () => {
    const two = [rect(0, 0, 20, 20), rect(10, 0, 20, 20)];
    // x=19 靠近第一个区域的右边界，但深在第二个区域内部
    expect(featherAlphaAt(19, 10, two, 5)).toBe(255);
  });

  it('treats a zero radius as a hard edge', () => {
    expect(featherAlphaAt(10, 30, regions, 0)).toBe(255);
    expect(featherAlphaAt(9, 30, regions, 0)).toBe(0);
  });
});

describe('buildFeatherAlpha', () => {
  it('produces one entry per pixel and zeroes outside', () => {
    const alpha = buildFeatherAlpha(20, 20, [rect(5, 5, 10, 10)], 3);
    expect(alpha.length).toBe(400);
    expect(alpha[0]).toBe(0); // (0,0)
    expect(alpha[10 * 20 + 10]).toBe(255); // 区域中心
  });

  it('is all zero when there are no regions', () => {
    const alpha = buildFeatherAlpha(8, 8, [], 3);
    expect(Array.from(alpha).every((v) => v === 0)).toBe(true);
  });
});

describe('compositePixels', () => {
  /** 构造纯色 RGBA 平面。 */
  function plane(n: number, r: number, g: number, b: number, a = 255) {
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i += 1) {
      out[i * 4] = r;
      out[i * 4 + 1] = g;
      out[i * 4 + 2] = b;
      out[i * 4 + 3] = a;
    }
    return out;
  }

  it('leaves masked-out pixels bit-identical', () => {
    // A3 的回归防线：模型输出再怎么色偏，也不能渗到蒙版之外
    const n = 16;
    const base = plane(n, 10, 20, 30);
    const before = Uint8ClampedArray.from(base);
    const result = plane(n, 200, 210, 220);
    const alpha = new Uint8ClampedArray(n); // 全 0
    compositePixels(base, result, alpha);
    expect(Array.from(base)).toEqual(Array.from(before));
  });

  it('fully replaces pixels at alpha 255', () => {
    const n = 4;
    const base = plane(n, 10, 20, 30);
    const result = plane(n, 200, 210, 220);
    const alpha = new Uint8ClampedArray(n).fill(255);
    compositePixels(base, result, alpha);
    expect([base[0], base[1], base[2]]).toEqual([200, 210, 220]);
  });

  it('blends linearly at intermediate alpha', () => {
    const n = 1;
    const base = plane(n, 0, 0, 0);
    const result = plane(n, 100, 200, 40);
    const alpha = new Uint8ClampedArray([128]);
    compositePixels(base, result, alpha);
    const w = 128 / 255;
    expect(base[0]).toBe(Math.round(100 * w));
    expect(base[1]).toBe(Math.round(200 * w));
    expect(base[2]).toBe(Math.round(40 * w));
  });

  it('only touches pixels inside the mask region', () => {
    // 端到端：4x1 图，只有第 2 个像素在蒙版内
    const base = plane(4, 10, 10, 10);
    const result = plane(4, 250, 250, 250);
    const alpha = new Uint8ClampedArray([0, 255, 0, 0]);
    compositePixels(base, result, alpha);
    expect([base[0], base[4], base[8], base[12]]).toEqual([10, 250, 10, 10]);
  });

  it('returns the same array instance it mutated', () => {
    const base = plane(1, 1, 2, 3);
    const out = compositePixels(base, plane(1, 9, 9, 9), new Uint8ClampedArray([255]));
    expect(out).toBe(base);
  });
});
