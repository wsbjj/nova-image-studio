import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SliceAsset, SlicePlacement, SliceWorkspaceDraft } from '@/lib/slice-types';

let blobSeq = 0;

vi.mock('@/lib/slice-db', () => ({
  saveWorkspace: async () => {},
  listWorkspaces: async () => [],
  getWorkspace: async () => null,
  putBlob: async () => {
    blobSeq += 1;
    return `blob-${blobSeq}`;
  },
  getBlob: async () => null,
  deleteBlob: async () => {},
  deleteWorkspace: async () => {},
  copyWorkspace: async () => null,
}));
vi.mock('../../../lib/slice-db', async () => await import('@/lib/slice-db'));

// jsdom 不实现 canvas。这里桩掉 2D context 与 toBlob，让 slice-crop 的真实代码路径
// （含圆角 clip 与版本守卫）真正跑起来，同时记录每次 drawImage 的源矩形，
// 用来断言"重裁剪用的是新坐标"。
const cropCalls: SlicePlacement[] = [];

beforeAll(() => {
  const ctxStub = {
    drawImage: (
      _img: unknown,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
    ) => {
      cropCalls.push({ x: sx, y: sy, width: sw, height: sh });
    },
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    clip: () => {},
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctxStub as unknown as CanvasRenderingContext2D,
  );
  HTMLCanvasElement.prototype.toBlob = function toBlob(cb: BlobCallback) {
    cb(new Blob(['x'], { type: 'image/png' }));
  };
});

const { recropAsset, isCropVersionCurrent, nextCropVersion } = await import('@/lib/slice-crop');
const { useSliceStore } = await import('@/components/slice/stores/use-slice-store');

const screen = { width: 750, height: 1334 };

function makeAsset(id: string, placement: SlicePlacement): SliceAsset {
  return {
    id,
    name: id,
    type: 'manual_slice',
    placement,
    radius: 0,
    transparent: false,
    aiTransparent: false,
    aiCompleted: false,
    hidden: false,
    originalBlobKey: `orig-${id}`,
    currentBlobKey: `cur-${id}`,
  };
}

function seed(assets: SliceAsset[]) {
  const draft: SliceWorkspaceDraft = {
    id: 'ws',
    note: '',
    createdAt: '',
    updatedAt: '',
    screen,
    sourceImageBlobKey: 'src',
    thumbnailBlobKey: null,
    assets,
  };
  useSliceStore.setState({
    activeWorkspaceId: 'ws',
    activeWorkspace: draft,
    workspaces: [draft],
    past: [],
    future: [],
  });
}

beforeEach(() => {
  cropCalls.length = 0;
  blobSeq = 0;
  useSliceStore.getState().endGesture();
});

describe('crop version guard', () => {
  it('marks only the newest request as current', () => {
    const v1 = nextCropVersion('a');
    expect(isCropVersionCurrent('a', v1)).toBe(true);
    const v2 = nextCropVersion('a');
    // 旧请求作废，新请求有效 —— 这防止慢的先发请求覆盖快的后发结果
    expect(isCropVersionCurrent('a', v1)).toBe(false);
    expect(isCropVersionCurrent('a', v2)).toBe(true);
  });

  it('discards a stale in-flight recrop', async () => {
    const asset = makeAsset('a', { x: 0, y: 0, width: 50, height: 50 });
    const inflight = recropAsset({} as HTMLImageElement, asset, screen);
    // 模拟用户在上一次 await 未返回时又拖了一次
    nextCropVersion('a');
    await expect(inflight).resolves.toBeNull();
  });

  it('returns a patch that resets derived AI state', async () => {
    const asset = makeAsset('a', { x: 10, y: 20, width: 50, height: 60 });
    const patch = await recropAsset({} as HTMLImageElement, asset, screen);
    expect(patch).not.toBeNull();
    expect(patch!.transparent).toBe(false);
    expect(patch!.aiCompleted).toBe(false);
    expect(patch!.transparentBlobKey).toBeNull();
    expect(patch!.repairBlobKey).toBeNull();
    // original 与 current 指向同一张新裁剪
    expect(patch!.currentBlobKey).toBe(patch!.originalBlobKey);
    expect(patch!.currentBlobKey).not.toBe('cur-a');
  });
});

describe('recrop reads fresh placement after a store write', () => {
  it('crops the NEW rect, not the pre-move one', async () => {
    // 这是本次修复的核心回归：SliceEditor 在 await applySilent(...) 之后立刻重裁剪，
    // 若从 useEffect 同步的 ref 读取 workspace，就会拿到旧 placement 并裁出旧图。
    seed([makeAsset('a', { x: 0, y: 0, width: 50, height: 50 })]);
    const store = useSliceStore.getState();

    store.beginGesture('移动切图');
    await store.applySilent((d) => {
      d.assets[0].placement = { x: 300, y: 400, width: 50, height: 50 };
    });

    // 模拟 recropAssets：从 store 直接读最新状态
    const ws = useSliceStore.getState().activeWorkspace!;
    const patch = await recropAsset({} as HTMLImageElement, ws.assets[0], ws.screen);
    store.endGesture();

    expect(patch).not.toBeNull();
    expect(cropCalls).toHaveLength(1);
    expect(cropCalls[0]).toEqual({ x: 300, y: 400, width: 50, height: 50 });
  });

  it('keeps the recrop write-back out of the undo stack', async () => {
    seed([makeAsset('a', { x: 0, y: 0, width: 50, height: 50 })]);
    const store = useSliceStore.getState();

    store.beginGesture('移动切图');
    await store.applySilent((d) => {
      d.assets[0].placement = { x: 300, y: 400, width: 50, height: 50 };
    });
    const ws = useSliceStore.getState().activeWorkspace!;
    const patch = await recropAsset({} as HTMLImageElement, ws.assets[0], ws.screen);
    await store.applySilent((d) => Object.assign(d.assets[0], patch));
    store.endGesture();

    // 整段拖拽 + 重裁剪写回 = 恰好一条历史
    expect(useSliceStore.getState().past).toHaveLength(1);
    await store.undo();
    const after = useSliceStore.getState().activeWorkspace!.assets[0];
    expect(after.placement).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(after.currentBlobKey).toBe('cur-a');
  });
});
