// 资产处理状态机：算法透明 / AI透明 / 算法SVG / AI SVG 四个操作的应用与还原。
//
// 移植自 imagetoslice/src/ui/state/slice-ai-state.js，但有两处关键改写：
//   1. 上游快照存 dataUrl，这里存 Blob key —— 图片一律在 blobs store，
//      快照只记引用，工作区记录不会被 base64 撑爆。
//   2. 上游只有 transparencyRestoreState / svgRestoreState 两个槽位，
//      算法版与 AI 版共用一个，于是「AI透明」会顶掉「算法透明」的还原点。
//      这里改成 processSnapshots 按 op 分槽，四个操作各自独立可逆。
//
// 纯函数：接收 asset、返回新 asset，不触碰 IndexedDB，可直接单测。

import type { SliceAsset, SliceProcessOp, SliceProcessSnapshot } from './slice-types';

/** 操作 → 中文标签。用于按钮、徽章与历史条目。 */
export const PROCESS_OP_LABELS: Record<SliceProcessOp, string> = {
  transparent: '透明',
  aiTransparent: 'AI 透明',
  svg: 'SVG',
  aiSvg: 'AI SVG',
};

/** 该操作当前是否已生效（决定按钮显示「执行」还是「还原」）。 */
export function isProcessOpActive(asset: SliceAsset, op: SliceProcessOp): boolean {
  switch (op) {
    case 'transparent':
      // 算法透明：处于透明态且不是 AI 产出的
      return Boolean(asset.transparent) && !asset.aiTransparent;
    case 'aiTransparent':
      return Boolean(asset.aiTransparent);
    case 'svg':
      return Boolean(asset.svgData) && !asset.svgFromAi;
    case 'aiSvg':
      return Boolean(asset.svgData) && Boolean(asset.svgFromAi);
  }
}

/** 该资产是否存在任何已生效的处理结果（用于破坏性调整前的确认）。 */
export function hasAnyProcessResult(asset: SliceAsset): boolean {
  return Boolean(asset.transparent || asset.aiTransparent || asset.svgData);
}

/** 列出当前生效的操作，顺序固定，便于生成稳定的提示文案。 */
export function listActiveProcessOps(asset: SliceAsset): SliceProcessOp[] {
  const ops: SliceProcessOp[] = ['transparent', 'aiTransparent', 'svg', 'aiSvg'];
  return ops.filter((op) => isProcessOpActive(asset, op));
}

/**
 * 破坏性调整前的确认文案。
 * 按实际生效的操作组合措辞，而不是一句笼统的「已处理」——
 * 用户需要知道自己将要丢掉的是哪一项（尤其是花了额度的 AI 结果）。
 */
export function describeProcessResetMessage(asset: SliceAsset): string {
  const name = asset.name || '切图资产';
  const labels = listActiveProcessOps(asset).map((op) => PROCESS_OP_LABELS[op]);
  if (labels.length === 0) return `调整「${name}」将重新裁剪，是否继续？`;
  return `「${name}」已应用${labels.join('、')}，调整切图将取消这些处理结果，是否继续？`;
}

/** 拍下操作前的现场。写入前调用，保证还原点是「这次操作之前」的状态。 */
export function captureProcessSnapshot(asset: SliceAsset): SliceProcessSnapshot {
  return {
    currentBlobKey: asset.currentBlobKey,
    transparent: Boolean(asset.transparent),
    aiTransparent: Boolean(asset.aiTransparent),
    svgData: asset.svgData ?? null,
    svgFromAi: Boolean(asset.svgFromAi),
  };
}

/**
 * 应用一次透明化结果。
 *
 * 透明与 SVG 是互斥的呈现形式：写入透明位图后清掉 svgData，
 * 否则列表既显示「透明」又显示「SVG」，而实际只有一份图能生效。
 * 被清掉的 svgData 已经进了快照，还原时会回来。
 */
export function applyTransparencyResult(
  asset: SliceAsset,
  params: { blobKey: string; ai: boolean },
): SliceAsset {
  const { blobKey, ai } = params;
  const op: SliceProcessOp = ai ? 'aiTransparent' : 'transparent';
  return {
    ...asset,
    currentBlobKey: blobKey,
    transparent: true,
    aiTransparent: ai,
    ...(ai ? { aiTransparentBlobKey: blobKey } : { transparentBlobKey: blobKey }),
    svgData: null,
    svgFromAi: false,
    processSnapshots: {
      ...(asset.processSnapshots ?? {}),
      [op]: captureProcessSnapshot(asset),
    },
  };
}

/**
 * 应用一次矢量化结果。
 *
 * 只写 svgData，不动 currentBlobKey：位图仍是画布与导出 PNG 的来源，
 * SVG 是附加产物。这样「转 SVG」不会让画布突然变空，还原也更便宜。
 */
export function applySvgResult(
  asset: SliceAsset,
  params: { svgData: string; ai: boolean },
): SliceAsset {
  const { svgData, ai } = params;
  const op: SliceProcessOp = ai ? 'aiSvg' : 'svg';
  return {
    ...asset,
    svgData,
    svgFromAi: ai,
    processSnapshots: {
      ...(asset.processSnapshots ?? {}),
      [op]: captureProcessSnapshot(asset),
    },
  };
}

/**
 * 还原某个操作。
 * @returns 还原后的 asset；该操作没有快照时返回 null（调用方据此跳过历史记录）。
 */
export function restoreProcessOp(asset: SliceAsset, op: SliceProcessOp): SliceAsset | null {
  const snapshot = asset.processSnapshots?.[op];
  if (!snapshot) return null;

  const nextSnapshots = { ...(asset.processSnapshots ?? {}) };
  delete nextSnapshots[op];

  return {
    ...asset,
    currentBlobKey: snapshot.currentBlobKey,
    transparent: snapshot.transparent,
    aiTransparent: snapshot.aiTransparent,
    svgData: snapshot.svgData ?? null,
    svgFromAi: Boolean(snapshot.svgFromAi),
    // 清掉本次操作产出的派生 key，避免悬挂引用被 GC 逻辑误判为仍在使用
    ...(op === 'transparent' ? { transparentBlobKey: null } : {}),
    ...(op === 'aiTransparent' ? { aiTransparentBlobKey: null } : {}),
    processSnapshots: Object.keys(nextSnapshots).length > 0 ? nextSnapshots : null,
  };
}

/**
 * 清空全部处理结果，回到原始裁剪。
 * 重裁剪（移动/缩放/改圆角）后调用：新的位图与旧的透明/矢量结果已经对不上。
 */
export function clearProcessResults(asset: SliceAsset): SliceAsset {
  return {
    ...asset,
    transparent: false,
    aiTransparent: false,
    transparentBlobKey: null,
    aiTransparentBlobKey: null,
    svgData: null,
    svgFromAi: false,
    processSnapshots: null,
  };
}
