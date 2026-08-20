// 切图几何工具层
// 移植自 imagetoslice/src/ui/services/slice-geometry.js，改写为 TypeScript。
// 纯函数、不依赖 DOM，可直接单测。所有坐标均为源图像素坐标。

import type { SliceAsset, SlicePlacement, SliceRadii, SliceScreen } from './slice-types';

/** 切图框最小边长（像素）。低于此值的框选被丢弃。 */
export const MIN_SLICE_SIZE = 8;

/**
 * 源图单边像素上限。
 * 对齐 imagetoslice/src/core/ai-image-dimensions.js 的 MAX_AI_IMAGE_DIMENSION：
 * 图片理解与图片编辑端点都在 4096 以内，超限图必须在入口拦下，
 * 否则要等到 AI 请求返回才失败，白等一次昂贵调用。
 */
export const MAX_SOURCE_IMAGE_DIMENSION = 4096;

/**
 * 校验源图尺寸是否可进入切图流程。
 * @returns null 表示通过；否则返回可直接展示的中文错误原因。
 */
export function describeSourceImageSizeError(width: number, height: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '图片尺寸无效，请重新选择图片。';
  }
  if (width > MAX_SOURCE_IMAGE_DIMENSION || height > MAX_SOURCE_IMAGE_DIMENSION) {
    return (
      `图片尺寸为 ${Math.round(width)} × ${Math.round(height)}，`
      + `当前最大支持 ${MAX_SOURCE_IMAGE_DIMENSION} × ${MAX_SOURCE_IMAGE_DIMENSION}，请缩小后重新上传。`
    );
  }
  return null;
}

/** 四角顺序：与 CSS border-radius 的书写顺序一致。 */
export const SLICE_RADIUS_CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;

export type SliceRadiusCorner = (typeof SLICE_RADIUS_CORNERS)[number];

/** 八向缩放手柄。n/s/e/w 为边中点，其余为角。 */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

/** 兜底的画布尺寸，仅在调用方尚未加载源图时使用。 */
const FALLBACK_SCREEN: SliceScreen = { width: 4096, height: 4096 };

/**
 * 将 value 夹取到 [min, max]。
 * 空值（null / undefined / 空白字符串）与非有限数字返回 fallback，而不是静默变成 0 ——
 * 这样数字输入框被清空时保留原值，而不会把切图跳到坐标 0。
 * 注意：源项目直接用 `Number(value)`，空字符串会变成 0；此处刻意与之不同。
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < min) return min;
  if (numeric > max) return max;
  return numeric;
}

/** 光标位置 → 源图像素坐标（用于按渲染尺寸缩放的场景，如背景确认弹窗）。 */
export function pointToScreenCoords(
  clientX: number,
  clientY: number,
  imageRect: { left: number; top: number; width: number; height: number },
  screen: SliceScreen,
): { x: number; y: number } {
  const x = ((clientX - imageRect.left) / Math.max(1, imageRect.width)) * screen.width;
  const y = ((clientY - imageRect.top) / Math.max(1, imageRect.height)) * screen.height;
  return {
    x: clampNumber(Math.round(x), 0, screen.width, 0),
    y: clampNumber(Math.round(y), 0, screen.height, 0),
  };
}

/**
 * 单个字段在当前 placement 下的合法上限。
 * 属性面板用它约束 input 的 max，避免用户输入把切图推出画布。
 */
export function getSliceFieldMax(
  placement: Partial<SlicePlacement> | undefined,
  field: 'x' | 'y' | 'width' | 'height' | 'radius',
  screen: SliceScreen = FALLBACK_SCREEN,
): number {
  const p = placement || {};
  switch (field) {
    case 'x':
      return Math.max(0, Math.round(screen.width - Math.max(1, Number(p.width) || 1)));
    case 'y':
      return Math.max(0, Math.round(screen.height - Math.max(1, Number(p.height) || 1)));
    case 'width':
      return Math.max(1, Math.round(screen.width - Math.max(0, Number(p.x) || 0)));
    case 'height':
      return Math.max(1, Math.round(screen.height - Math.max(0, Number(p.y) || 0)));
    case 'radius':
      return Math.max(
        0,
        Math.floor(Math.min(Number(p.width) || 0, Number(p.height) || 0) / 2),
      );
    default:
      return 4096;
  }
}

/**
 * 读取切图的四角圆角。
 * 兼容旧数据：`radii` 缺失时由标量 `radius` 推导，因此无需 IndexedDB 迁移。
 * 每个角都夹取到短边一半。
 */
export function getSliceRadii(
  asset: Pick<SliceAsset, 'placement'> & { radius?: number; radii?: SliceRadii | null },
  screen: SliceScreen = FALLBACK_SCREEN,
): SliceRadii {
  const maxRadius = getSliceFieldMax(asset?.placement, 'radius', screen);
  const fallback = Math.round(clampNumber(Number(asset?.radius) || 0, 0, maxRadius, 0));
  const explicit = asset?.radii && typeof asset.radii === 'object' ? asset.radii : null;
  return {
    topLeft: Math.round(clampNumber(explicit ? explicit.topLeft : fallback, 0, maxRadius, fallback)),
    topRight: Math.round(clampNumber(explicit ? explicit.topRight : fallback, 0, maxRadius, fallback)),
    bottomRight: Math.round(
      clampNumber(explicit ? explicit.bottomRight : fallback, 0, maxRadius, fallback),
    ),
    bottomLeft: Math.round(
      clampNumber(explicit ? explicit.bottomLeft : fallback, 0, maxRadius, fallback),
    ),
  };
}

/** 四角是否全为 0（用于跳过圆角裁剪这条较慢的路径）。 */
export function isZeroRadii(radii: SliceRadii): boolean {
  return SLICE_RADIUS_CORNERS.every((corner) => radii[corner] === 0);
}

/**
 * 设置单个角的圆角，返回新的 { radii, radius }。
 * `radius` 始终保持为四角最大值，供旧代码路径与导出 manifest 使用。
 */
export function setSliceCornerRadius(
  asset: Pick<SliceAsset, 'placement'> & { radius?: number; radii?: SliceRadii | null },
  corner: SliceRadiusCorner,
  value: number,
  screen: SliceScreen = FALLBACK_SCREEN,
): { radii: SliceRadii; radius: number } {
  const radii = getSliceRadii(asset, screen);
  radii[corner] = Math.round(
    clampNumber(value, 0, getSliceFieldMax(asset?.placement, 'radius', screen), radii[corner]),
  );
  return { radii, radius: Math.max(...SLICE_RADIUS_CORNERS.map((c) => radii[c])) };
}

/** 四角设为同一个值。 */
export function setUniformRadius(
  asset: Pick<SliceAsset, 'placement'> & { radius?: number; radii?: SliceRadii | null },
  value: number,
  screen: SliceScreen = FALLBACK_SCREEN,
): { radii: SliceRadii; radius: number } {
  const max = getSliceFieldMax(asset?.placement, 'radius', screen);
  const v = Math.round(clampNumber(value, 0, max, 0));
  return {
    radii: { topLeft: v, topRight: v, bottomRight: v, bottomLeft: v },
    radius: v,
  };
}

/**
 * 把任意 placement 规整为画布内的合法整数矩形。
 * 用于数字输入提交、AI 结果落库、粘贴等所有外部来源的坐标。
 */
export function normalizeSlicePlacement(
  placement: Partial<SlicePlacement>,
  screen: SliceScreen = FALLBACK_SCREEN,
  minSize = 1,
): SlicePlacement {
  const x = Math.round(clampNumber(placement.x, 0, Math.max(0, screen.width - minSize), 0));
  const y = Math.round(clampNumber(placement.y, 0, Math.max(0, screen.height - minSize), 0));
  const width = Math.round(
    clampNumber(placement.width, minSize, Math.max(minSize, screen.width - x), minSize),
  );
  const height = Math.round(
    clampNumber(placement.height, minSize, Math.max(minSize, screen.height - y), minSize),
  );
  return { x, y, width, height };
}

/**
 * 平移：整体位移后夹取在画布内，尺寸不变。
 * 夹取而非拒绝，让贴边拖拽的手感是"顶住边界"而不是"卡住不动"。
 */
export function movePlacement(
  start: SlicePlacement,
  dx: number,
  dy: number,
  screen: SliceScreen,
): SlicePlacement {
  return {
    x: Math.round(clampNumber(start.x + dx, 0, Math.max(0, screen.width - start.width), start.x)),
    y: Math.round(clampNumber(start.y + dy, 0, Math.max(0, screen.height - start.height), start.y)),
    width: start.width,
    height: start.height,
  };
}

/**
 * 八向缩放：按 handle 决定哪几条边跟随位移，其余边保持不动。
 * 每条边都夹取在画布内，且保证结果不小于 minSize。
 */
export function resizePlacement(
  start: SlicePlacement,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  screen: SliceScreen,
  minSize = MIN_SLICE_SIZE,
): SlicePlacement {
  let x1 = start.x;
  let y1 = start.y;
  let x2 = start.x + start.width;
  let y2 = start.y + start.height;

  if (handle.includes('w')) {
    x1 = clampNumber(start.x + dx, 0, x2 - minSize, x1);
  }
  if (handle.includes('e')) {
    x2 = clampNumber(start.x + start.width + dx, x1 + minSize, screen.width, x2);
  }
  if (handle.includes('n')) {
    y1 = clampNumber(start.y + dy, 0, y2 - minSize, y1);
  }
  if (handle.includes('s')) {
    y2 = clampNumber(start.y + start.height + dy, y1 + minSize, screen.height, y2);
  }

  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.max(minSize, Math.round(x2 - x1)),
    height: Math.max(minSize, Math.round(y2 - y1)),
  };
}

/** 由框选起止点得到规整矩形（起点可以在终点的任意一侧）。 */
export function normalizeDraftRect(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  screen: SliceScreen,
): SlicePlacement {
  const x1 = clampNumber(Math.min(startX, currentX), 0, screen.width, 0);
  const y1 = clampNumber(Math.min(startY, currentY), 0, screen.height, 0);
  const x2 = clampNumber(Math.max(startX, currentX), 0, screen.width, screen.width);
  const y2 = clampNumber(Math.max(startY, currentY), 0, screen.height, screen.height);
  return {
    x: Math.round(x1),
    y: Math.round(y1),
    width: Math.max(1, Math.round(x2 - x1)),
    height: Math.max(1, Math.round(y2 - y1)),
  };
}

/**
 * 圆角手柄的内拖公式：把光标位移投影到该角的向内方向。
 * 四个角的方向不同，因此各自有一组符号。
 */
export function calculateDraggedSliceRadius(
  corner: SliceRadiusCorner,
  startRadius: number,
  dx: number,
  dy: number,
  maxRadius: number,
): number {
  const direction: Record<SliceRadiusCorner, [number, number]> = {
    topLeft: [1, 1],
    topRight: [-1, 1],
    bottomRight: [-1, -1],
    bottomLeft: [1, -1],
  };
  const [sx, sy] = direction[corner];
  const inwardDelta = (dx * sx + dy * sy) / 2;
  return Math.round(clampNumber(startRadius + inwardDelta, 0, Math.max(0, maxRadius), 0));
}

/** 两个 placement 是否有实质差异（避免无变化时触发重裁剪与历史记录）。 */
export function hasSlicePlacementChanged(a: SlicePlacement, b: SlicePlacement): boolean {
  return a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height;
}

/** 两个矩形是否相交（框选多选的命中判定，边缘接触算相交）。 */
export function rectsIntersect(a: SlicePlacement, b: SlicePlacement): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

// ===== 吸附对齐 =====

/** 一条吸附辅助线。`position` 为源图坐标，画布据此渲染提示线。 */
export interface SnapGuide {
  axis: 'x' | 'y';
  position: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/** 收集一个矩形在某个轴上的三条参考位置：起边、中线、终边。 */
function edgesOf(rect: SlicePlacement, axis: 'x' | 'y'): number[] {
  return axis === 'x'
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
}

/**
 * 计算拖拽中的吸附修正量。
 *
 * 参考线来自：其它切图的起边/中线/终边，以及画布的起边/中线/终边。
 * 每个轴只取距离最近的一条命中线，返回需要额外施加的位移 dx/dy 与用于渲染的辅助线。
 * `threshold` 由调用方按 `4 / zoom` 传入，使吸附手感与屏幕像素而非源图像素挂钩。
 */
export function computeSnap(
  moving: SlicePlacement,
  others: SlicePlacement[],
  screen: SliceScreen,
  threshold: number,
): SnapResult {
  const guides: SnapGuide[] = [];
  let bestDx = 0;
  let bestDy = 0;

  for (const axis of ['x', 'y'] as const) {
    const movingEdges = edgesOf(moving, axis);
    const canvasSpan = axis === 'x' ? screen.width : screen.height;
    const targets: number[] = [0, canvasSpan / 2, canvasSpan];
    for (const other of others) targets.push(...edgesOf(other, axis));

    let bestDelta: number | null = null;
    let bestTarget = 0;
    for (const edge of movingEdges) {
      for (const target of targets) {
        const delta = target - edge;
        if (Math.abs(delta) > threshold) continue;
        if (bestDelta === null || Math.abs(delta) < Math.abs(bestDelta)) {
          bestDelta = delta;
          bestTarget = target;
        }
      }
    }

    if (bestDelta !== null) {
      guides.push({ axis, position: bestTarget });
      if (axis === 'x') bestDx = bestDelta;
      else bestDy = bestDelta;
    }
  }

  return { dx: bestDx, dy: bestDy, guides };
}
