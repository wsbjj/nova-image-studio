import { describe, expect, it } from 'vitest';

import { parseDecompositionData } from '../slice-ai-client';

const W = 1000;
const H = 800;

describe('parseDecompositionData', () => {
  it('保留合法切图并归一化 bbox', () => {
    const result = parseDecompositionData(
      {
        assets: [
          { kind: 'logo', name: 'brand', bbox: { x: 10, y: 20, width: 120, height: 40 }, confidence: 0.9 },
          { kind: 'icon', bbox: { x: 200, y: 300, width: 32, height: 32 } },
        ],
      },
      W,
      H,
    );
    expect(result.assets).toHaveLength(2);
    expect(result.droppedAssets).toBe(0);
    expect(result.assets[0].bbox).toEqual({ x: 10, y: 20, width: 120, height: 40 });
    expect(result.assets[0].name).toBe('brand');
  });

  it('负数宽高的 bbox 会被翻正而不是丢弃', () => {
    const result = parseDecompositionData(
      { assets: [{ kind: 'icon', bbox: { x: 300, y: 200, width: -100, height: -50 } }] },
      W,
      H,
    );
    expect(result.droppedAssets).toBe(0);
    expect(result.assets[0].bbox).toEqual({ x: 200, y: 150, width: 100, height: 50 });
  });

  it('kind 不在白名单时计入 droppedAssets', () => {
    const result = parseDecompositionData(
      {
        assets: [
          { kind: 'text', bbox: { x: 0, y: 0, width: 100, height: 100 } },
          { kind: 'logo', bbox: { x: 0, y: 0, width: 100, height: 100 } },
        ],
      },
      W,
      H,
    );
    expect(result.assets).toHaveLength(1);
    expect(result.droppedAssets).toBe(1);
  });

  it('bbox 太小或非法时计入 droppedAssets', () => {
    const result = parseDecompositionData(
      {
        assets: [
          { kind: 'icon', bbox: { x: 0, y: 0, width: 1, height: 1 } },
          { kind: 'icon', bbox: { x: 'a', y: 0, width: 50, height: 50 } },
          { kind: 'icon' },
        ],
      },
      W,
      H,
    );
    expect(result.assets).toHaveLength(0);
    expect(result.droppedAssets).toBe(3);
  });

  it('统计被丢弃的背景候选', () => {
    const result = parseDecompositionData(
      {
        backgrounds: [
          { bbox: { x: 0, y: 0, width: 500, height: 400 } },
          { bbox: { x: 0, y: 0, width: 2, height: 2 } },
          'not-an-object',
        ],
      },
      W,
      H,
    );
    expect(result.backgrounds).toHaveLength(1);
    expect(result.droppedBackgrounds).toBe(2);
  });

  it('输入不是对象时返回空结果而不抛错', () => {
    expect(parseDecompositionData(null, W, H)).toEqual({
      assets: [],
      backgrounds: [],
      droppedAssets: 0,
      droppedBackgrounds: 0,
    });
  });
});
