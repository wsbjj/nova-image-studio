import { describe, expect, it } from 'vitest';

import {
  buildReconstructZipFiles,
  collectReferencedAssetIds,
  collectReferenceAssetDescriptors,
  findUnresolvedAssetIds,
  type HydratedAsset,
} from '@/lib/slice-reconstruct';
import type { SliceAsset, SliceWorkspaceDraft } from '@/lib/slice-types';

function asset(id: string, overrides: Partial<SliceAsset> = {}): SliceAsset {
  return {
    id,
    name: id,
    type: 'icon',
    placement: { x: 0, y: 0, width: 10, height: 10 },
    radius: 0,
    transparent: false,
    aiTransparent: false,
    aiCompleted: false,
    hidden: false,
    originalBlobKey: `${id}-blob`,
    currentBlobKey: `${id}-blob`,
    ...overrides,
  };
}

function workspace(assets: SliceAsset[]): SliceWorkspaceDraft {
  return {
    id: 'ws',
    note: '',
    createdAt: '',
    updatedAt: '',
    screen: { width: 390, height: 844 },
    sourceImageBlobKey: 'src',
    assets,
  };
}

function hydrated(id: string): HydratedAsset {
  return {
    id,
    name: id,
    dataUrl: 'data:image/png;base64,AAAA',
    placement: { x: 0, y: 0, width: 10, height: 10 },
    radius: 0,
  };
}

describe('collectReferenceAssetDescriptors', () => {
  it('collects visible assets and skips hidden ones', () => {
    const result = collectReferenceAssetDescriptors(
      workspace([asset('a1'), asset('a2', { hidden: true }), asset('a3')]),
    );
    expect(result.map((r) => r.id)).toEqual(['a1', 'a3']);
  });

  // id 撞车会让注入阶段随机挑一张图，页面「配错了图」却看不出原因
  it('throws on duplicate ids instead of silently deduping', () => {
    expect(() => collectReferenceAssetDescriptors(workspace([asset('dup'), asset('dup')]))).toThrow(
      /重复/,
    );
  });

  it('throws on an empty id', () => {
    expect(() => collectReferenceAssetDescriptors(workspace([asset('')]))).toThrow(/缺少 id/);
  });

  it('does not treat a hidden duplicate as a collision', () => {
    expect(() =>
      collectReferenceAssetDescriptors(workspace([asset('dup'), asset('dup', { hidden: true })])),
    ).not.toThrow();
  });
});

describe('collectReferencedAssetIds', () => {
  it('picks up both the src and the data attribute form', () => {
    const html = '<img src="asset:a1"><img data-reference-asset="a2" src="./x.png">';
    expect(collectReferencedAssetIds(html)).toEqual(new Set(['a1', 'a2']));
  });

  it('dedupes repeated references', () => {
    const html = '<img src="asset:a1"><img data-reference-asset="a1" src="asset:a1">';
    expect(collectReferencedAssetIds(html)).toEqual(new Set(['a1']));
  });

  it('returns an empty set for HTML with no assets', () => {
    expect(collectReferencedAssetIds('<div>hi</div>').size).toBe(0);
    expect(collectReferencedAssetIds('').size).toBe(0);
  });
});

describe('findUnresolvedAssetIds', () => {
  it('flags ids the model invented', () => {
    const html = '<img src="asset:a1"><img src="asset:hero_image">';
    expect(findUnresolvedAssetIds(html, [{ id: 'a1' }])).toEqual(['hero_image']);
  });

  it('returns nothing when every reference resolves', () => {
    const html = '<img src="asset:a1"><img data-reference-asset="a2" src="asset:a2">';
    expect(findUnresolvedAssetIds(html, [{ id: 'a1' }, { id: 'a2' }])).toEqual([]);
  });

  it('ignores assets that exist but are never referenced', () => {
    expect(findUnresolvedAssetIds('<div/>', [{ id: 'a1' }])).toEqual([]);
  });
});

describe('buildReconstructZipFiles', () => {
  const files = {
    'index.html': '<html><body><img src="asset:used"></body></html>',
    'styles.css': '.a{}',
    'script.js': 'a()',
  };

  it('rewrites asset: refs to relative paths and packs the image', () => {
    const out = buildReconstructZipFiles(files, [hydrated('used')]);
    const html = new TextDecoder().decode(out['index.html']);
    expect(html).toContain('src="./assets/asset-used.png"');
    expect(html).not.toContain('asset:used');
    expect(out['assets/asset-used.png']).toBeDefined();
  });

  // 模型常常用不上全部切图；未引用的打进包里只是无人认领的死图
  it('skips assets the HTML never references', () => {
    const out = buildReconstructZipFiles(files, [hydrated('used'), hydrated('unused')]);
    expect(out['assets/asset-used.png']).toBeDefined();
    expect(out['assets/asset-unused.png']).toBeUndefined();
  });

  it('always emits the three source files', () => {
    const out = buildReconstructZipFiles(files, []);
    expect(Object.keys(out).sort()).toEqual(['index.html', 'script.js', 'styles.css']);
  });
});
