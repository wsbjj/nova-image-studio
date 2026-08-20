'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Eye,
  EyeOff,
  Loader2,
  Maximize,
  MousePointer2,
  Redo2,
  RotateCcw,
  Shapes,
  Sparkles,
  Square,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { nanoid } from 'nanoid';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { getBlob, putBlob } from '@/lib/slice-db';
import {
  requestSliceDecomposition,
  type DecompositionResult,
} from '@/lib/slice-ai-client';
import {
  loadJsonFromStorage,
  saveJsonToStorage,
} from '@/lib/settings-storage';
import { hasSliceImageModel, hasSliceTextModel } from '@/lib/slice-model-config';
import {
  describeSliceImageModel,
  SliceImageModelPicker,
} from './SliceImageModelPicker';
import type {
  SliceAsset,
  SlicePlacement,
  SliceProcessOp,
  SliceScreen,
  SliceSettings,
  SliceWorkspaceDraft,
} from '@/lib/slice-types';
import {
  applySvgResult,
  applyTransparencyResult,
  clearProcessResults,
  describeProcessResetMessage,
  hasAnyProcessResult,
  isProcessOpActive,
  PROCESS_OP_LABELS,
  restoreProcessOp,
} from '@/lib/slice-process-state';
import {
  runAiSvg,
  runAiTransparent,
  runBatchOp,
  runLocalSvg,
  runLocalTransparent,
} from '@/lib/slice-process-runner';
import {
  MIN_SLICE_SIZE,
  RESIZE_HANDLES,
  SLICE_RADIUS_CORNERS,
  calculateDraggedSliceRadius,
  computeSnap,
  getSliceFieldMax,
  getSliceRadii,
  hasSlicePlacementChanged,
  movePlacement,
  normalizeDraftRect,
  normalizeSlicePlacement,
  rectsIntersect,
  resizePlacement,
  setSliceCornerRadius,
  type ResizeHandle,
  type SliceRadiusCorner,
  type SnapGuide,
} from '@/lib/slice-geometry';
import { forgetCropVersion, recropAsset, renderThumbnailBlob } from '@/lib/slice-crop';
import { createRepairedPreviewBlob } from '@/lib/slice-repair';

import {
  selectCanRedo,
  selectCanUndo,
  selectRedoLabel,
  selectUndoLabel,
  useSliceStore,
} from './stores/use-slice-store';
import { useBlobUrl } from './use-blob-url';
import { SliceAssetPanel } from './SliceAssetPanel';
import { SlicePropertyPanel } from './SlicePropertyPanel';
import { BackgroundConfirmDialog } from './BackgroundConfirmDialog';
import { SliceContextMenu } from './SliceContextMenu';
import { SliceInpaintEditor } from './SliceInpaintEditor';
import { DecomposeReviewDialog, type DecomposeCandidate } from './DecomposeReviewDialog';
import { StreamingCodePanel } from './StreamingCodePanel';

import { useSliceKeyboard } from './use-slice-keyboard';
import { cropImageBlob, imageElementToDataUrl } from './slice-canvas-utils';

interface SliceEditorProps {
  workspaceId: string;
  onConfigureApiKey: () => void;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  /** 向父级报告当前切图流程是否会因切换 Tab 而中断。 */
  onTaskStateChange?: (busy: boolean) => void;
}

const SLICE_SETTINGS_KEY = 'nova-slice-settings';
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

type DragState =
  | { mode: 'pan'; startClient: { x: number; y: number }; startOffset: { x: number; y: number } }
  | { mode: 'draw'; startClient: { x: number; y: number }; startImg: { x: number; y: number }; liveRect: SlicePlacement | null }
  /** 空白处拖拽框选多选 */
  | {
      mode: 'marquee';
      startImg: { x: number; y: number };
      /** 按下时已有的选中集合（Shift 加选 / Alt 减选的基准） */
      baseSelection: Set<string>;
      additive: boolean;
      subtractive: boolean;
      liveRect: SlicePlacement | null;
    }
  | {
      mode: 'move';
      startClient: { x: number; y: number };
      startPlacements: Record<string, SlicePlacement>;
      /** 主拖拽对象，用于计算吸附 */
      anchorId: string;
      live: Record<string, SlicePlacement> | null;
    }
  | {
      mode: 'resize';
      assetId: string;
      handle: ResizeHandle;
      startClient: { x: number; y: number };
      startPlacement: SlicePlacement;
      live: SlicePlacement | null;
    }
  /** 拖拽四角圆角手柄 */
  | {
      mode: 'radius';
      assetId: string;
      corner: SliceRadiusCorner;
      startClient: { x: number; y: number };
      startRadius: number;
      maxRadius: number;
      live: number | null;
    };

/** 将 AI 拆图返回的 kind 映射为本地 SliceKind 字符串 */
function mapDecompKind(kind: string): string {
  switch (kind) {
    case 'icon':
    case 'avatar':
    case 'logo':
      return 'icon';
    case 'illustration':
    case 'photo':
      return 'illustration';
    case 'product-image':
      return 'product';
    case 'complex-decoration':
      return 'complex-decoration';
    default:
      return 'other';
  }
}

/** 粘贴/原地复制时的偏移量（像素），与源项目一致。 */
const PASTE_OFFSET = 10;
/** 方向键连按时，停止多久后才真正重裁剪。 */
const RECROP_DEBOUNCE_MS = 300;
/** 吸附阈值（屏幕像素），换算到源图坐标时除以 zoom。 */
const SNAP_THRESHOLD_PX = 4;

/**
 * 画布查看模式。
 * - source：源图 + 切图轮廓（默认）
 * - cutout：挖洞图 —— 抠掉所有可见切图，缺口用本地边缘混合补丁填充
 * - slices：棋盘底 + 仅显示切图内容
 */
type ViewMode = 'source' | 'cutout' | 'slices';

const VIEW_MODE_OPTIONS: Array<{ value: ViewMode; label: string; hint: string }> = [
  { value: 'source', label: '原图', hint: '显示源图与切图轮廓' },
  { value: 'cutout', label: '挖洞', hint: '抠掉切图后的效果（本地预览，不消耗 AI）' },
  { value: 'slices', label: '仅切图', hint: '棋盘底上只显示切图内容' },
];

/** 在已有名称中生成不重复的副本名：`名称 副本` → `名称 副本 2` → … */
function uniqueCopyName(baseName: string, existing: SliceAsset[]): string {
  const taken = new Set(existing.map((a) => a.name));
  const base = `${baseName || '切图'} 副本`;
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

/** 深拷贝单个 asset：复制关联 Blob，生成新 id 与不重名的名称 */
async function copyAssetDeep(asset: SliceAsset, existing: SliceAsset[] = []): Promise<SliceAsset> {
  const copyBlobKey = async (key: string | null | undefined): Promise<string | null> => {
    if (!key) return null;
    const blob = await getBlob(key);
    if (!blob) return key;
    return putBlob(blob, blob.type || 'image/png');
  };
  const [originalBlobKey, currentBlobKey, transparentBlobKey, aiTransparentBlobKey] = await Promise.all([
    copyBlobKey(asset.originalBlobKey),
    copyBlobKey(asset.currentBlobKey),
    copyBlobKey(asset.transparentBlobKey),
    copyBlobKey(asset.aiTransparentBlobKey),
  ]);
  return {
    ...asset,
    id: nanoid(),
    name: uniqueCopyName(asset.name, existing),
    originalBlobKey: originalBlobKey || asset.originalBlobKey,
    currentBlobKey: currentBlobKey || asset.currentBlobKey,
    transparentBlobKey: transparentBlobKey || null,
    aiTransparentBlobKey: aiTransparentBlobKey || null,
  };
}

function handleCursor(h: ResizeHandle): string {
  if (h === 'n' || h === 's') return 'ns-resize';
  if (h === 'e' || h === 'w') return 'ew-resize';
  return h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize';
}

/** 手柄在框上的定位样式。角在四角，边中点在边的中间。 */
function handlePosition(h: ResizeHandle): React.CSSProperties {
  const centerX = { left: '50%', transform: 'translate(-50%, -50%)' } as const;
  const centerY = { top: '50%', transform: 'translate(-50%, -50%)' } as const;
  switch (h) {
    case 'nw':
      return { left: 0, top: 0, transform: 'translate(-50%, -50%)' };
    case 'n':
      return { ...centerX, top: 0 };
    case 'ne':
      return { right: 0, top: 0, transform: 'translate(50%, -50%)' };
    case 'e':
      return { ...centerY, right: 0, transform: 'translate(50%, -50%)' };
    case 'se':
      return { right: 0, bottom: 0, transform: 'translate(50%, 50%)' };
    case 's':
      return { ...centerX, bottom: 0, transform: 'translate(-50%, 50%)' };
    case 'sw':
      return { left: 0, bottom: 0, transform: 'translate(-50%, 50%)' };
    case 'w':
    default:
      return { ...centerY, left: 0, transform: 'translate(-50%, -50%)' };
  }
}

/**
 * 切图编辑器主框架：
 * - 顶部工具栏：AI 拆图 / 模型选择器 / 批量操作 / 框选工具
 * - 左侧画布：源图 + 切图框选叠加层，支持缩放（滚轮/按钮）、平移、框选、拖拽、缩放手柄
 * - 右侧侧栏：切图资产列表（SliceAssetPanel）
 * - 子弹窗：设置抽屉 / AI 补齐编辑器 / 背景确认弹窗
 */
export function SliceEditor({ onConfigureApiKey, showToast, onTaskStateChange }: SliceEditorProps) {
  const activeWorkspace = useSliceStore((s) => s.activeWorkspace);
  const commit = useSliceStore((s) => s.commit);
  const mergeCommit = useSliceStore((s) => s.mergeCommit);
  const beginGesture = useSliceStore((s) => s.beginGesture);
  const endGesture = useSliceStore((s) => s.endGesture);
  const applySilent = useSliceStore((s) => s.applySilent);
  const undo = useSliceStore((s) => s.undo);
  const redo = useSliceStore((s) => s.redo);
  const canUndo = useSliceStore(selectCanUndo);
  const canRedo = useSliceStore(selectCanRedo);
  const undoLabel = useSliceStore(selectUndoLabel);
  const redoLabel = useSliceStore(selectRedoLabel);

  // ===== 设置（图片模型选择，持久化到 localStorage） =====
  // 存的是 registry 条目 id。条目被删除后 requireSliceImageModel 会自动回退，
  // 所以这里不需要在加载时校验有效性。
  const [settings, setSettings] = useState<SliceSettings>(() => {
    const loaded = loadJsonFromStorage<SliceSettings>(SLICE_SETTINGS_KEY);
    return {
      model: typeof loaded.model === 'string' ? loaded.model : '',
      useTokenMode: false,
    };
  });
  const handleModelSelect = (next: { id: string }) => {
    const nextSettings: SliceSettings = { model: next.id, useTokenMode: false };
    setSettings(nextSettings);
    saveJsonToStorage(SLICE_SETTINGS_KEY, nextSettings);
  };

  // ===== 画布状态 =====
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [tool, setTool] = useState<'select' | 'draw'>('select');
  // 拖拽过程中的临时 placement 覆盖（避免每次 mousemove 都更新 store）
  const [drafts, setDrafts] = useState<Record<string, SlicePlacement>>({});
  const [drawDraft, setDrawDraft] = useState<SlicePlacement | null>(null);

  // ===== loading / 弹窗状态 =====
  const [isDecomposing, setIsDecomposing] = useState(false);
  const [backgroundDialogOpen, setBackgroundDialogOpen] = useState(false);
  const [backgroundCandidates, setBackgroundCandidates] = useState<
    DecompositionResult['backgrounds']
  >([]);
  // 右键菜单「切图设置」会把该切图设为唯一选中项，属性面板随即显示它；
  // 这里保留一个标记用于 Esc 的分级收起顺序。
  const [settingsAssetId, setSettingsAssetId] = useState<string | null>(null);
  const [inpaintAssetId, setInpaintAssetId] = useState<string | null>(null);
  // 空格按住 = 临时平移（光标反馈需要参与渲染，故同时有 state 与 ref）
  const [spaceHeld, setSpaceHeld] = useState(false);
  // 算法类处理进行中（透明 / SVG，批量时逐张处理，需要禁用按钮并给反馈）
  const [processBusy, setProcessBusy] = useState(false);
  // 正在进行的 AI 类处理（AI透明 / AI SVG）。只允许一个，因此不是集合。
  const [aiOp, setAiOp] = useState<{
    id: string;
    op: 'aiTransparent' | 'aiSvg';
    elapsed: number;
  } | null>(null);
  // AI 拆图：计时、候选确认、待处理的背景候选
  const [decomposeElapsed, setDecomposeElapsed] = useState(0);
  const [decomposeStreamText, setDecomposeStreamText] = useState('');
  const [decomposeStreamPhase, setDecomposeStreamPhase] = useState('正在分析截图');
  const [decomposeCandidates, setDecomposeCandidates] = useState<DecomposeCandidate[]>([]);
  const [decomposeDialogOpen, setDecomposeDialogOpen] = useState(false);
  const [pendingBackgrounds, setPendingBackgrounds] = useState(false);
  // 查看模式与挖洞图（挖洞图按需生成，切换回原图后保留以免反复重算）
  const [viewMode, setViewMode] = useState<ViewMode>('source');
  const [cutoutUrl, setCutoutUrl] = useState<string | null>(null);
  const [cutoutLoading, setCutoutLoading] = useState(false);
  // 框选多选的实时矩形
  const [marquee, setMarquee] = useState<SlicePlacement | null>(null);
  // 吸附辅助线
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  // 圆角拖拽中的临时值（避免每次 pointermove 都写 store）
  const [radiusDraft, setRadiusDraft] = useState<
    { assetId: string; corner: SliceRadiusCorner; value: number } | null
  >(null);
  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; assetId: string } | null>(
    null,
  );
  // 破坏性调整确认：Promise 化，让 recropAssets 能 await 用户的选择。
  const [processResetPrompt, setProcessResetPrompt] = useState<{
    assets: SliceAsset[];
    resolve: (accepted: boolean) => void;
  } | null>(null);

  const sliceTaskBusy =
    isDecomposing ||
    processBusy ||
    aiOp !== null ||
    cutoutLoading ||
    inpaintAssetId !== null ||
    decomposeDialogOpen ||
    backgroundDialogOpen;

  useEffect(() => {
    onTaskStateChange?.(sliceTaskBusy);
    return () => onTaskStateChange?.(false);
  }, [onTaskStateChange, sliceTaskBusy]);

  // AI 处理计时。与 AI 拆图同样的做法：只在进行中挂一个 1s interval。
  // 依赖用派生出的 key 而不是 aiOp 本身：elapsed 每秒变化会产生新对象，
  // 直接依赖 aiOp 会让 interval 每秒被销毁重建。
  const aiOpKey = aiOp ? `${aiOp.id}:${aiOp.op}` : null;
  useEffect(() => {
    if (!aiOpKey) return;
    const timer = setInterval(() => {
      setAiOp((prev) => (prev ? { ...prev, elapsed: prev.elapsed + 1 } : prev));
    }, 1000);
    return () => clearInterval(timer);
  }, [aiOpKey]);

  // ===== refs =====
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sourceImgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const zoomRef = useRef(zoom);
  const offsetRef = useRef(offset);
  const workspaceRef = useRef<SliceWorkspaceDraft | null>(activeWorkspace);
  const spaceHeldRef = useRef(false);
  /** 内部剪贴板：切图是 Blob 引用，无法走系统剪贴板 */
  const clipboardRef = useRef<SliceAsset[]>([]);
  const recropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRecropRef = useRef<Set<string>>(new Set());
  const decomposeAbortRef = useRef<AbortController | null>(null);
  const aiOpAbortRef = useRef<AbortController | null>(null);
  // 未决的破坏性调整确认的 resolver，仅用于卸载兜底
  const pendingResetResolveRef = useRef<((accepted: boolean) => void) | null>(null);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { offsetRef.current = offset; }, [offset]);
  useEffect(() => { workspaceRef.current = activeWorkspace; }, [activeWorkspace]);

  // ===== 源图加载（用于裁剪 / dataURL） =====
  const sourceUrl = useBlobUrl(activeWorkspace?.sourceImageBlobKey);
  useEffect(() => {
    if (!sourceUrl) {
      sourceImgRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      sourceImgRef.current = img;
      // 首次进入时补一张工作区缩略图：移植版从不写 thumbnailBlobKey，
      // 导致历史列表每张卡片都是占位剪刀图标。
      const ws = useSliceStore.getState().activeWorkspace;
      if (ws && !ws.thumbnailBlobKey) {
        void (async () => {
          try {
            const blob = await renderThumbnailBlob(img);
            const key = await putBlob(blob, 'image/png');
            if (!key) return;
            // 缩略图是派生数据，不入历史
            await applySilent((draft) => {
              draft.thumbnailBlobKey = key;
            });
          } catch {
            // 缩略图失败不影响主流程
          }
        })();
      }
    };
    img.onerror = () => {
      sourceImgRef.current = null;
    };
    img.src = sourceUrl;
  }, [sourceUrl, applySilent]);

  // ===== 适应画布 =====
  const fitToScreen = useCallback(() => {
    const el = viewportRef.current;
    const ws = workspaceRef.current;
    if (!el || !ws) return;
    const rect = el.getBoundingClientRect();
    const w = ws.screen.width;
    const h = ws.screen.height;
    if (!w || !h || !rect.width || !rect.height) return;
    const z = Math.min(rect.width / w, rect.height / h);
    const off = { x: (rect.width - w * z) / 2, y: (rect.height - h * z) / 2 };
    zoomRef.current = z;
    offsetRef.current = off;
    setZoom(z);
    setOffset(off);
  }, []);

  // 源图首次加载后自动适应
  useEffect(() => {
    if (sourceUrl) fitToScreen();
  }, [sourceUrl, fitToScreen]);

  // ===== 缩放控制 =====
  const zoomAt = useCallback((factor: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const oldZoom = zoomRef.current;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor));
    const imgX = (cx - rect.left - offsetRef.current.x) / oldZoom;
    const imgY = (cy - rect.top - offsetRef.current.y) / oldZoom;
    const off = { x: cx - rect.left - imgX * newZoom, y: cy - rect.top - imgY * newZoom };
    zoomRef.current = newZoom;
    offsetRef.current = off;
    setZoom(newZoom);
    setOffset(off);
  }, []);

  const setZoomCentered = useCallback((targetZoom: number) => {
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const oldZoom = zoomRef.current;
    const imgX = (cx - rect.left - offsetRef.current.x) / oldZoom;
    const imgY = (cy - rect.top - offsetRef.current.y) / oldZoom;
    const off = { x: cx - rect.left - imgX * targetZoom, y: cy - rect.top - imgY * targetZoom };
    zoomRef.current = targetZoom;
    offsetRef.current = off;
    setZoom(targetZoom);
    setOffset(off);
  }, []);

  // ===== 滚轮缩放（非被动监听以阻止页面滚动） =====
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, oldZoom * factor));
      const imgX = (e.clientX - rect.left - offsetRef.current.x) / oldZoom;
      const imgY = (e.clientY - rect.top - offsetRef.current.y) / oldZoom;
      const off = {
        x: e.clientX - rect.left - imgX * newZoom,
        y: e.clientY - rect.top - imgY * newZoom,
      };
      zoomRef.current = newZoom;
      offsetRef.current = off;
      setZoom(newZoom);
      setOffset(off);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ===== 重裁剪 =====

  /**
   * 弹出破坏性调整确认，返回用户是否同意作废处理结果。
   * resolver 同时记在 ref 上，卸载时可以兜底 resolve，避免 recropAssets 永久挂起。
   */
  const requestProcessResetConfirm = useCallback(
    (targets: SliceAsset[]) =>
      new Promise<boolean>((resolve) => {
        pendingResetResolveRef.current = resolve;
        setProcessResetPrompt({ assets: targets, resolve });
      }),
    [],
  );

  /** 收起确认弹窗并把结果交回等待方。 */
  const settleProcessResetPrompt = useCallback((accepted: boolean) => {
    pendingResetResolveRef.current = null;
    setProcessResetPrompt((prev) => {
      prev?.resolve(accepted);
      return null;
    });
  }, []);

  // 卸载时兜底：未决的确认按「不同意」结束
  useEffect(
    () => () => {
      pendingResetResolveRef.current?.(false);
      pendingResetResolveRef.current = null;
    },
    [],
  );

  // 这是修复"移动/缩放后导出图与框选区域对不上"的关键：placement 变了就必须重新裁源图。
  // 走 applySilent 写回，避免在拖拽产生的那条历史之后再多出一条。
  const recropAssets = useCallback(
    async (ids: string[]) => {
      const img = sourceImgRef.current;
      if (!img || ids.length === 0) return;
      // 必须从 store 直接读，不能用 workspaceRef：ref 由 useEffect 同步，
      // 而调用方通常是在 await applySilent(...) 之后立刻调用本函数，此时 effect 还没跑，
      // ref 里仍是旧 placement —— 那样重裁剪出来的还是旧图，等于没修。
      // zustand 的 set 是同步的，getState() 能立刻拿到最新值。
      const ws = useSliceStore.getState().activeWorkspace;
      if (!ws) return;

      // 重裁剪会产出新位图，已有的透明/矢量结果与之对不上，必须一并作废。
      // 花过额度的 AI 结果不能静默丢弃，所以先征询一次（每个资产只问一次）。
      const needConfirm = ids
        .map((id) => ws.assets.find((a) => a.id === id))
        .filter(
          (a): a is SliceAsset =>
            Boolean(a) && !a!.locked && hasAnyProcessResult(a!) && !a!.processResetConfirmed,
        );

      let declinedIds = new Set<string>();
      if (needConfirm.length > 0) {
        const accepted = await requestProcessResetConfirm(needConfirm);
        if (accepted) {
          const confirmedIds = new Set(needConfirm.map((a) => a.id));
          await applySilent((draft) => {
            for (const asset of draft.assets) {
              if (confirmedIds.has(asset.id)) asset.processResetConfirmed = true;
            }
          });
        } else {
          // 用户选择保留处理结果 → 这些资产跳过重裁剪。
          // 代价是它们的裁剪与新框位置不一致，因此明确告知，而不是静默放过。
          declinedIds = new Set(needConfirm.map((a) => a.id));
          showToast(
            `已保留 ${declinedIds.size} 个切图的处理结果，其裁剪未随框选更新`,
            'info',
          );
        }
      }

      const patches = await Promise.all(
        ids.map(async (id) => {
          if (declinedIds.has(id)) return null;
          const asset = ws.assets.find((a) => a.id === id);
          // locked 资产（已保留的 AI 结果）不重裁剪
          if (!asset || asset.locked) return null;
          try {
            const patch = await recropAsset(img, asset, ws.screen);
            return patch ? ({ id, patch } as const) : null;
          } catch {
            return null;
          }
        }),
      );

      const valid = patches.filter((p): p is NonNullable<typeof p> => p !== null);
      if (valid.length === 0) return;

      await applySilent((draft) => {
        for (const { id, patch } of valid) {
          const index = draft.assets.findIndex((a) => a.id === id);
          if (index < 0) continue;
          Object.assign(draft.assets[index], patch);
          // 新位图已写入，作废旧的透明/矢量结果与其还原点
          draft.assets[index] = clearProcessResults(draft.assets[index]);
        }
      });
    },
    [applySilent, requestProcessResetConfirm, showToast],
  );

  /**
   * 防抖重裁剪：方向键连按时每次都重裁剪既浪费又会闪，
   * 累积 id 集合，停手 300ms 后统一裁一次。
   */
  const scheduleRecrop = useCallback(
    (ids: string[]) => {
      for (const id of ids) pendingRecropRef.current.add(id);
      if (recropTimerRef.current) clearTimeout(recropTimerRef.current);
      recropTimerRef.current = setTimeout(() => {
        recropTimerRef.current = null;
        const pending = Array.from(pendingRecropRef.current);
        pendingRecropRef.current.clear();
        void recropAssets(pending);
      }, RECROP_DEBOUNCE_MS);
    },
    [recropAssets],
  );

  // 卸载时清掉待执行的重裁剪定时器
  useEffect(
    () => () => {
      if (recropTimerRef.current) clearTimeout(recropTimerRef.current);
    },
    [],
  );

  // ===== 创建切图（从画布框选） =====
  const createSliceFromRect = useCallback(
    async (rect: SlicePlacement) => {
      const img = sourceImgRef.current;
      const ws = workspaceRef.current;
      if (!img || !ws) return;
      try {
        const placement = normalizeSlicePlacement(rect, ws.screen, MIN_SLICE_SIZE);
        const blob = await cropImageBlob(img, placement);
        const key = await putBlob(blob, 'image/png');
        if (!key) {
          showToast('切图保存失败', 'error');
          return;
        }
        const id = nanoid();
        const asset: SliceAsset = {
          id,
          name: `切图 ${ws.assets.length + 1}`,
          type: 'manual_slice',
          placement,
          radius: 0,
          radii: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
          source: 'manual',
          transparent: false,
          aiTransparent: false,
          aiCompleted: false,
          hidden: false,
          originalBlobKey: key,
          currentBlobKey: key,
        };
        await commit('新增切图', (draft) => {
          draft.assets.push(asset);
        });
        setSelectedIds(new Set([id]));
      } catch (err) {
        showToast(err instanceof Error ? err.message : '创建切图失败', 'error');
      }
    },
    [commit, showToast],
  );

  // ===== 拖拽：window 级 pointer 监听（始终挂载，根据 dragRef 分发） =====
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      const rect = viewportRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (drag.mode === 'pan') {
        const dx = e.clientX - drag.startClient.x;
        const dy = e.clientY - drag.startClient.y;
        const off = { x: drag.startOffset.x + dx, y: drag.startOffset.y + dy };
        offsetRef.current = off;
        setOffset(off);
      } else if (drag.mode === 'draw') {
        const imgX = (e.clientX - rect.left - offsetRef.current.x) / zoomRef.current;
        const imgY = (e.clientY - rect.top - offsetRef.current.y) / zoomRef.current;
        const screen = workspaceRef.current?.screen;
        const liveRect = screen
          ? normalizeDraftRect(drag.startImg.x, drag.startImg.y, imgX, imgY, screen)
          : {
              x: Math.min(drag.startImg.x, imgX),
              y: Math.min(drag.startImg.y, imgY),
              width: Math.abs(imgX - drag.startImg.x),
              height: Math.abs(imgY - drag.startImg.y),
            };
        drag.liveRect = liveRect;
        setDrawDraft(liveRect);
      } else if (drag.mode === 'marquee') {
        const screen = workspaceRef.current?.screen;
        if (!screen) return;
        const imgX = (e.clientX - rect.left - offsetRef.current.x) / zoomRef.current;
        const imgY = (e.clientY - rect.top - offsetRef.current.y) / zoomRef.current;
        const liveRect = normalizeDraftRect(drag.startImg.x, drag.startImg.y, imgX, imgY, screen);
        drag.liveRect = liveRect;
        setMarquee(liveRect);
        // 实时反馈命中的切图
        const ws = workspaceRef.current;
        if (ws) {
          const hits = ws.assets.filter((a) => rectsIntersect(liveRect, a.placement)).map((a) => a.id);
          const next = new Set(drag.baseSelection);
          for (const id of hits) {
            if (drag.subtractive) next.delete(id);
            else next.add(id);
          }
          setSelectedIds(next);
        }
      } else if (drag.mode === 'move') {
        const screen = workspaceRef.current?.screen;
        const rawDx = (e.clientX - drag.startClient.x) / zoomRef.current;
        const rawDy = (e.clientY - drag.startClient.y) / zoomRef.current;
        let dx = rawDx;
        let dy = rawDy;

        // 吸附：以主拖拽对象为基准，按住 Alt 关闭
        if (screen && !e.altKey) {
          const anchorStart = drag.startPlacements[drag.anchorId];
          const ws = workspaceRef.current;
          if (anchorStart && ws) {
            const moved = movePlacement(anchorStart, rawDx, rawDy, screen);
            const others = ws.assets
              .filter((a) => !(a.id in drag.startPlacements))
              .map((a) => a.placement);
            const snap = computeSnap(moved, others, screen, SNAP_THRESHOLD_PX / zoomRef.current);
            dx = rawDx + snap.dx;
            dy = rawDy + snap.dy;
            setSnapGuides(snap.guides);
          }
        } else {
          setSnapGuides([]);
        }

        const live: Record<string, SlicePlacement> = {};
        for (const [id, p] of Object.entries(drag.startPlacements)) {
          // 夹取在画布内：越界会裁出全透明图
          live[id] = screen ? movePlacement(p, dx, dy, screen) : { ...p, x: p.x + dx, y: p.y + dy };
        }
        drag.live = live;
        setDrafts((prev) => ({ ...prev, ...live }));
      } else if (drag.mode === 'radius') {
        const dx = (e.clientX - drag.startClient.x) / zoomRef.current;
        const dy = (e.clientY - drag.startClient.y) / zoomRef.current;
        const next = calculateDraggedSliceRadius(
          drag.corner,
          drag.startRadius,
          dx,
          dy,
          drag.maxRadius,
        );
        drag.live = next;
        setRadiusDraft({ assetId: drag.assetId, corner: drag.corner, value: next });
      } else if (drag.mode === 'resize') {
        const screen = workspaceRef.current?.screen;
        if (!screen) return;
        const dx = (e.clientX - drag.startClient.x) / zoomRef.current;
        const dy = (e.clientY - drag.startClient.y) / zoomRef.current;
        const live = resizePlacement(drag.startPlacement, drag.handle, dx, dy, screen, MIN_SLICE_SIZE);
        drag.live = live;
        setDrafts((prev) => ({ ...prev, [drag.assetId]: live }));
      }
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;

      if (drag.mode === 'move' && drag.live) {
        const live = drag.live;
        setSnapGuides([]);
        const changedIds = Object.entries(live)
          .filter(([id, p]) => {
            const before = drag.startPlacements[id];
            return before && hasSlicePlacementChanged(before, p);
          })
          .map(([id]) => id);
        void (async () => {
          if (changedIds.length > 0) {
            await applySilent((draft) => {
              for (const a of draft.assets) {
                const p = live[a.id];
                if (p) a.placement = { ...p };
              }
            });
            await recropAssets(changedIds);
          }
          endGesture();
          setDrafts({});
        })();
      } else if (drag.mode === 'resize' && drag.live) {
        const live = drag.live;
        const assetId = drag.assetId;
        const changed = hasSlicePlacementChanged(drag.startPlacement, live);
        void (async () => {
          if (changed) {
            await applySilent((draft) => {
              const a = draft.assets.find((x) => x.id === assetId);
              if (a) a.placement = { ...live };
            });
            await recropAssets([assetId]);
          }
          endGesture();
          setDrafts({});
        })();
      } else if (drag.mode === 'draw' && drag.liveRect) {
        const rect = drag.liveRect;
        if (rect.width >= MIN_SLICE_SIZE && rect.height >= MIN_SLICE_SIZE) {
          void createSliceFromRect(rect);
        }
        setDrawDraft(null);
      } else if (drag.mode === 'marquee') {
        // 选中集合已在 pointermove 中实时更新，这里只收尾
        setMarquee(null);
      } else if (drag.mode === 'radius' && drag.live !== null) {
        const value = drag.live;
        const assetId = drag.assetId;
        const corner = drag.corner;
        void (async () => {
          await applySilent((draft) => {
            const a = draft.assets.find((x) => x.id === assetId);
            if (!a) return;
            const next = setSliceCornerRadius(a, corner, value, draft.screen);
            a.radii = next.radii;
            a.radius = next.radius;
          });
          // 圆角影响裁剪结果（圆角外为透明像素），必须重裁剪
          await recropAssets([assetId]);
          endGesture();
          setRadiusDraft(null);
        })();
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [applySilent, createSliceFromRect, endGesture, recropAssets]);

  // ===== 画布交互入口 =====
  const handleViewportPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // 让根容器拿到焦点，快捷键才会生效（与源项目 layer.focus() 同思路）
    rootRef.current?.focus({ preventScroll: true });
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 按住空格时强制平移，优先于当前工具
    if (spaceHeldRef.current) {
      dragRef.current = {
        mode: 'pan',
        startClient: { x: e.clientX, y: e.clientY },
        startOffset: { ...offsetRef.current },
      };
      return;
    }

    const imgX = (e.clientX - rect.left - offsetRef.current.x) / zoomRef.current;
    const imgY = (e.clientY - rect.top - offsetRef.current.y) / zoomRef.current;

    if (tool === 'draw') {
      dragRef.current = {
        mode: 'draw',
        startClient: { x: e.clientX, y: e.clientY },
        startImg: { x: imgX, y: imgY },
        liveRect: null,
      };
      return;
    }

    // 选择工具下在空白处拖拽 = 框选多选（原先只能平移，无法多选）
    const additive = e.shiftKey;
    const subtractive = e.altKey;
    const base = additive || subtractive ? new Set(selectedIds) : new Set<string>();
    if (!additive && !subtractive) setSelectedIds(new Set());
    dragRef.current = {
      mode: 'marquee',
      startImg: { x: imgX, y: imgY },
      baseSelection: base,
      additive,
      subtractive,
      liveRect: null,
    };
  };

  /** 中键拖拽平移：不改变选中态，也不受当前工具影响。 */
  const handleViewportAuxPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    dragRef.current = {
      mode: 'pan',
      startClient: { x: e.clientX, y: e.clientY },
      startOffset: { ...offsetRef.current },
    };
  };

  const handleStartMove = (e: React.PointerEvent, asset: SliceAsset) => {
    if (e.button !== 0) return;
    // 空格按住时让事件冒泡到画布做平移，不进入移动切图
    if (spaceHeldRef.current) return;
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    const isMulti = e.ctrlKey || e.metaKey;
    // 同步计算点击后的选中集合（setSelectedIds 的 updater 异步执行，不能从中读取结果）
    let nextSelected: Set<string>;
    if (isMulti) {
      nextSelected = new Set(selectedIds);
      if (nextSelected.has(asset.id)) nextSelected.delete(asset.id);
      else nextSelected.add(asset.id);
    } else {
      nextSelected = new Set([asset.id]);
    }
    setSelectedIds(nextSelected);
    // 单击已选中的 asset（在多选集合中）时移动所有选中项；否则只移动当前 asset
    const wasSelected = selectedIds.has(asset.id);
    const moveIds =
      !isMulti && wasSelected && selectedIds.size > 1 ? selectedIds : new Set([asset.id]);
    const ws = workspaceRef.current;
    const startPlacements: Record<string, SlicePlacement> = {};
    if (ws) {
      for (const a of ws.assets) {
        if (moveIds.has(a.id)) startPlacements[a.id] = { ...a.placement };
      }
    }
    // 整段拖拽只记一条历史；endGesture 在 pointerup 后调用
    beginGesture(moveIds.size > 1 ? `移动 ${moveIds.size} 个切图` : '移动切图');
    dragRef.current = {
      mode: 'move',
      startClient: { x: e.clientX, y: e.clientY },
      startPlacements,
      anchorId: asset.id,
      live: null,
    };
  };

  /** 开始拖拽某个角的圆角手柄。 */
  const handleStartRadius = (
    e: React.PointerEvent,
    asset: SliceAsset,
    corner: SliceRadiusCorner,
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    const ws = workspaceRef.current;
    if (!ws) return;
    setSelectedIds(new Set([asset.id]));
    beginGesture('调整圆角');
    dragRef.current = {
      mode: 'radius',
      assetId: asset.id,
      corner,
      startClient: { x: e.clientX, y: e.clientY },
      startRadius: getSliceRadii(asset, ws.screen)[corner],
      maxRadius: getSliceFieldMax(asset.placement, 'radius', ws.screen),
      live: null,
    };
  };

  const handleStartResize = (e: React.PointerEvent, asset: SliceAsset, handle: ResizeHandle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedIds(new Set([asset.id]));
    beginGesture('缩放切图');
    dragRef.current = {
      mode: 'resize',
      assetId: asset.id,
      handle,
      startClient: { x: e.clientX, y: e.clientY },
      startPlacement: { ...asset.placement },
      live: null,
    };
  };

  // ===== 资产操作 =====
  const handleSelect = useCallback((id: string, multi: boolean) => {
    setSelectedIds((prev) => {
      if (multi) {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      return new Set([id]);
    });
  }, []);

  const handleCopyAsset = useCallback(
    async (id: string) => {
      const ws = workspaceRef.current;
      if (!ws) return;
      const asset = ws.assets.find((a) => a.id === id);
      if (!asset) return;
      try {
        const copy = await copyAssetDeep(asset);
        await commit('复制切图', (draft) => {
          const idx = draft.assets.findIndex((a) => a.id === id);
          if (idx >= 0) draft.assets.splice(idx + 1, 0, copy);
          else draft.assets.push(copy);
        });
        showToast('已复制切图', 'success');
      } catch {
        showToast('复制失败', 'error');
      }
    },
    [commit, showToast],
  );

  const handleDeleteAssets = useCallback(
    (ids: string[]) => {
      const set = new Set(ids);
      // 注意：不删对应的 Blob。撤销需要它们还在，回收统一交给关闭工作区时的 GC。
      void commit(ids.length > 1 ? `删除 ${ids.length} 个切图` : '删除切图', (draft) => {
        draft.assets = draft.assets.filter((a) => !set.has(a.id));
      });
      for (const id of ids) forgetCropVersion(id);
      setSelectedIds(new Set());
    },
    [commit],
  );

  const handleToggleHidden = useCallback(
    (id: string) => {
      void commit('切换显隐', (draft) => {
        const a = draft.assets.find((x) => x.id === id);
        if (a) a.hidden = !a.hidden;
      });
    },
    [commit],
  );

  const handleReorder = useCallback(
    (from: number, to: number) => {
      void commit('调整切图顺序', (draft) => {
        if (from < 0 || from >= draft.assets.length || to < 0 || to >= draft.assets.length) return;
        const [moved] = draft.assets.splice(from, 1);
        draft.assets.splice(to, 0, moved);
      });
    },
    [commit],
  );

  /**
   * 属性面板的字段更新，可作用于多个切图。
   * 用 mergeCommit + 按 id/字段构造的 mergeKey，让连续输入合并成一条历史；
   * placement/radii 变化后触发重裁剪。
   */
  const handleUpdateAssets = useCallback(
    (ids: string[], patch: Partial<SliceAsset>) => {
      const ws = useSliceStore.getState().activeWorkspace;
      if (!ws || ids.length === 0) return;
      const idSet = new Set(ids);
      const fields = Object.keys(patch).sort().join(',');

      const needsRecrop =
        patch.placement !== undefined || patch.radii !== undefined || patch.radius !== undefined;

      void (async () => {
        await mergeCommit(`asset:${ids.join(',')}:${fields}`, '修改切图属性', (draft) => {
          for (const a of draft.assets) {
            if (!idSet.has(a.id)) continue;
            Object.assign(a, patch);
            if (patch.placement) {
              a.placement = normalizeSlicePlacement(a.placement, draft.screen, MIN_SLICE_SIZE);
            }
          }
        });
        if (needsRecrop) scheduleRecrop(ids);
      })();
    },
    [mergeCommit, scheduleRecrop],
  );

  const handleInpaintSaved = useCallback(
    (assetId: string, newBlobKey: string) => {
      void commit('AI 补齐', (draft) => {
        const a = draft.assets.find((x) => x.id === assetId);
        if (a) {
          a.currentBlobKey = newBlobKey;
          a.aiCompleted = true;
        }
      });
    },
    [commit],
  );

  const handleBackgroundGenerated = useCallback(
    (newAssets: SliceAsset[]) => {
      void commit(`生成完整背景（${newAssets.length} 个）`, (draft) => {
        draft.assets.push(...newAssets);
      });
    },
    [commit],
  );

  // ===== 资产处理：算法透明 / AI透明 / 算法SVG / AI SVG =====

  /**
   * 执行一个算法类操作（透明 / SVG）。支持批量：不消耗 AI 额度。
   *
   * 单项失败不中断整批，最后汇总提示；整批成功项计为一条历史，撤销一次全部回退。
   */
  const handleLocalOp = useCallback(
    async (op: 'transparent' | 'svg', ids: string[]) => {
      const ws = useSliceStore.getState().activeWorkspace;
      if (!ws || ids.length === 0) return;

      // 已处于该操作生效态的跳过，避免重复计算
      const targets = ws.assets.filter(
        (a) => ids.includes(a.id) && !isProcessOpActive(a, op),
      );
      if (targets.length === 0) {
        showToast(`选中的切图已全部完成${PROCESS_OP_LABELS[op]}`, 'info');
        return;
      }

      setProcessBusy(true);
      try {
        const result =
          op === 'transparent'
            ? await runBatchOp(targets, runLocalTransparent)
            : await runBatchOp(targets, runLocalSvg);

        if (result.succeeded.length > 0) {
          const label = PROCESS_OP_LABELS[op];
          await commit(
            result.succeeded.length > 1
              ? `${label} ${result.succeeded.length} 个切图`
              : label,
            (draft) => {
              for (const { id, value } of result.succeeded) {
                const index = draft.assets.findIndex((x) => x.id === id);
                if (index < 0) continue;
                draft.assets[index] =
                  op === 'transparent'
                    ? applyTransparencyResult(draft.assets[index], { blobKey: value, ai: false })
                    : applySvgResult(draft.assets[index], { svgData: value, ai: false });
              }
            },
          );
        }

        // 失败项单独汇总：批量里挑出哪几张不行，比逐个弹 toast 更可读
        if (result.failed.length > 0) {
          const detail = result.failed
            .slice(0, 3)
            .map((f) => `${f.name}：${f.message}`)
            .join('；');
          const more = result.failed.length > 3 ? ` 等 ${result.failed.length} 项` : '';
          showToast(`${result.failed.length} 个切图处理失败 —— ${detail}${more}`, 'error');
        } else {
          showToast(`已完成 ${result.succeeded.length} 个切图的${PROCESS_OP_LABELS[op]}`, 'success');
        }
      } catch (err) {
        showToast(err instanceof Error ? err.message : '处理失败', 'error');
      } finally {
        setProcessBusy(false);
      }
    },
    [commit, showToast],
  );

  /**
   * 执行一个 AI 类操作（AI透明 / AI SVG）。只接受单个资产。
   *
   * 不提供批量入口：批量会在一次点击后连续扣费，中途失败也难以界定已消耗多少。
   * 处理中的资产记在 aiOpAssetId 上，界面据此显示进度与取消按钮。
   */
  const handleAiOp = useCallback(
    async (op: 'aiTransparent' | 'aiSvg', id: string) => {
      const ws = useSliceStore.getState().activeWorkspace;
      const asset = ws?.assets.find((a) => a.id === id);
      if (!ws || !asset) return;
      // AI 透明化打图片编辑端点，AI SVG 打文本模型 —— 两者缺的东西不同，分别提示
      if (op === 'aiTransparent' ? !hasSliceImageModel() : !hasSliceTextModel('sliceDecomposition')) {
        showToast(
          op === 'aiTransparent'
            ? '请先在设置中添加一个 OpenAI 协议的图片模型'
            : '请先在设置中为「AI 拆图」指定文本模型',
          'error',
        );
        onConfigureApiKey();
        return;
      }

      const controller = new AbortController();
      aiOpAbortRef.current = controller;
      setAiOp({ id, op, elapsed: 0 });
      try {
        if (op === 'aiTransparent') {
          const key = await runAiTransparent({
            asset,
            model: settings.model,
            signal: controller.signal,
          });
          await commit('AI 透明', (draft) => {
            const index = draft.assets.findIndex((x) => x.id === id);
            if (index >= 0) {
              draft.assets[index] = applyTransparencyResult(draft.assets[index], {
                blobKey: key,
                ai: true,
              });
            }
          });
          showToast('已生成 AI 透明 PNG，原切图仍可还原', 'success');
        } else {
          const svg = await runAiSvg({
            asset,
            signal: controller.signal,
            onRetry: () => showToast('SVG 校验未通过，正在重试', 'info'),
          });
          await commit('AI SVG', (draft) => {
            const index = draft.assets.findIndex((x) => x.id === id);
            if (index >= 0) {
              draft.assets[index] = applySvgResult(draft.assets[index], { svgData: svg, ai: true });
            }
          });
          showToast('已生成 AI 重绘 SVG', 'success');
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          showToast(`已取消${PROCESS_OP_LABELS[op]}`, 'info');
        } else {
          showToast(err instanceof Error ? err.message : `${PROCESS_OP_LABELS[op]}失败`, 'error');
        }
      } finally {
        aiOpAbortRef.current = null;
        setAiOp(null);
      }
    },
    [commit, onConfigureApiKey, settings.model, showToast],
  );

  /** 还原某个操作。四个操作各自独立，只回退这一项。 */
  const handleRestoreOp = useCallback(
    (op: SliceProcessOp, ids: string[]) => {
      const targetIds = new Set(ids);
      void commit(`还原${PROCESS_OP_LABELS[op]}`, (draft) => {
        for (let i = 0; i < draft.assets.length; i += 1) {
          const asset = draft.assets[i];
          if (!targetIds.has(asset.id) || !isProcessOpActive(asset, op)) continue;
          const restored = restoreProcessOp(asset, op);
          if (restored) draft.assets[i] = restored;
        }
      });
    },
    [commit],
  );

  // 兼容既有调用点（属性面板 / 右键菜单）的透明化入口
  const handleMakeTransparent = useCallback(
    (ids: string[]) => void handleLocalOp('transparent', ids),
    [handleLocalOp],
  );
  const handleRestoreTransparency = useCallback(
    (ids: string[]) => handleRestoreOp('transparent', ids),
    [handleRestoreOp],
  );

  // ===== 批量操作 =====

  /**
   * 批量执行一个算法操作：全部未处理 → 执行；全部已处理 → 全部还原。
   * 只有算法类（透明 / SVG）走这里，AI 类不提供批量入口。
   */
  const handleBatchLocalOp = (op: 'transparent' | 'svg') => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws || ws.assets.length === 0) return;
    const allActive = ws.assets.every((a) => isProcessOpActive(a, op));
    if (allActive) {
      handleRestoreOp(op, ws.assets.map((a) => a.id));
      return;
    }
    void handleLocalOp(
      op,
      ws.assets.filter((a) => !isProcessOpActive(a, op)).map((a) => a.id),
    );
  };
  const handleBatchToggleHidden = () => {
    const ws = workspaceRef.current;
    if (!ws || ws.assets.length === 0) return;
    const allHidden = ws.assets.every((a) => a.hidden);
    void commit(allHidden ? '全部显示' : '全部隐藏', (draft) => {
      for (const a of draft.assets) a.hidden = !allHidden;
    });
  };

  // ===== AI 拆图 =====
  const handleDecompose = async () => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws) return;
    if (!hasSliceTextModel('sliceDecomposition')) {
      showToast('请先在「设置 → 模型」中为「AI 拆图」指定文本模型', 'error');
      onConfigureApiKey();
      return;
    }
    const img = sourceImgRef.current;
    if (!img) {
      showToast('源图尚未加载完成，请稍后重试', 'error');
      return;
    }

    const controller = new AbortController();
    decomposeAbortRef.current = controller;
    setIsDecomposing(true);
    setDecomposeElapsed(0);
    setDecomposeStreamText('');
    setDecomposeStreamPhase('正在分析截图');
    // 计时器：视觉模型常需 60s+，没有进度反馈用户只能干等
    const startedAt = Date.now();
    const timer = setInterval(() => setDecomposeElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);

    try {
      const dataUrl = imageElementToDataUrl(img);
      const result = await requestSliceDecomposition({
        sourceImageDataUrl: dataUrl,
        width: ws.screen.width,
        height: ws.screen.height,
        signal: controller.signal,
        onStreamStart: (phase) => {
          setDecomposeStreamText('');
          setDecomposeStreamPhase(phase === 'repair' ? '正在修复 JSON' : '正在分析截图');
        },
        onDelta: (_delta, accumulated) => setDecomposeStreamText(accumulated),
        onRepairAttempt: () => showToast('模型返回的 JSON 有误，正在请求修复…', 'info'),
      });

      // 先裁剪出候选（落 blob 但不写进工作区），交给确认弹窗
      const candidates: DecomposeCandidate[] = [];
      let cropFailed = 0;
      for (const a of result.assets) {
        if (controller.signal.aborted) break;
        try {
          const placement = normalizeSlicePlacement(a.bbox, ws.screen, MIN_SLICE_SIZE);
          const blob = await cropImageBlob(img, placement);
          const key = await putBlob(blob, 'image/png');
          if (!key) {
            cropFailed += 1;
            continue;
          }
          candidates.push({
            confidence: a.confidence,
            reason: a.reason,
            asset: {
              id: nanoid(),
              name: a.name || `切图 ${candidates.length + 1}`,
              type: mapDecompKind(a.kind),
              placement,
              radius: 0,
              radii: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
              source: 'ai-asset',
              confidence: a.confidence,
              reason: a.reason,
              transparent: false,
              aiTransparent: false,
              aiCompleted: false,
              hidden: false,
              originalBlobKey: key,
              currentBlobKey: key,
            },
          });
        } catch {
          // 单个裁剪失败跳过，但要计数：静默丢弃会让"只拆出一个 logo"无从排查
          cropFailed += 1;
        }
      }

      if (controller.signal.aborted) return;

      // 模型给出但没能落地的条目数：校验丢弃 + 裁剪失败
      const lostAssets = result.droppedAssets + cropFailed;

      if (candidates.length > 0) {
        setDecomposeCandidates(candidates);
        setDecomposeDialogOpen(true);
        if (lostAssets > 0) {
          showToast(
            `AI 识别到 ${result.assets.length + result.droppedAssets} 个切图，${lostAssets} 个因坐标或裁剪失败被丢弃`,
            'info',
          );
        }
      } else if (lostAssets > 0) {
        showToast(`AI 返回的 ${lostAssets} 个切图坐标均无效，请重试`, 'error');
      } else if (result.backgrounds.length === 0) {
        showToast('AI 拆图未返回有效切图', 'info');
      }

      // 背景候选独立走背景确认弹窗
      if (result.backgrounds.length > 0) {
        setBackgroundCandidates(result.backgrounds);
        // 有普通切图待确认时，先让用户处理完再弹背景
        if (candidates.length === 0) setBackgroundDialogOpen(true);
        else setPendingBackgrounds(true);
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        showToast('已取消 AI 拆图', 'info');
      } else {
        showToast(err instanceof Error ? err.message : 'AI 拆图失败', 'error');
      }
    } finally {
      clearInterval(timer);
      decomposeAbortRef.current = null;
      setIsDecomposing(false);
    }
  };

  /** 确认落库：整批计为一条历史，撤销一次即可全部移除。 */
  const handleConfirmDecompose = useCallback(
    (assets: SliceAsset[], mode: 'append' | 'replace') => {
      void (async () => {
        await commit(
          mode === 'replace'
            ? `AI 拆图（替换为 ${assets.length} 个）`
            : `AI 拆图（新增 ${assets.length} 个）`,
          (draft) => {
            if (mode === 'replace') draft.assets = [...assets];
            else draft.assets.push(...assets);
          },
        );
        setDecomposeDialogOpen(false);
        setDecomposeCandidates([]);
        showToast(`已添加 ${assets.length} 个切图`, 'success');
        // 若本次还带回了背景候选，接着弹背景确认
        if (pendingBackgrounds) {
          setPendingBackgrounds(false);
          setBackgroundDialogOpen(true);
        }
      })();
    },
    [commit, pendingBackgrounds, showToast],
  );

  // ===== 挖洞图生成 =====
  // 只在切到 cutout 模式时算，且按"可见切图的几何签名"作为依赖：
  // 几何没变就不重算（否则每次选中/改名都要重画整张图）。
  const visibleGeometryKey = (activeWorkspace?.assets ?? [])
    .filter((a) => !a.hidden)
    .map((a) => `${a.placement.x},${a.placement.y},${a.placement.width},${a.placement.height}`)
    .join('|');

  useEffect(() => {
    if (viewMode !== 'cutout') return;
    const img = sourceImgRef.current;
    const ws = useSliceStore.getState().activeWorkspace;
    if (!img || !ws) return;

    let cancelled = false;
    let createdUrl: string | null = null;
    setCutoutLoading(true);

    const placements = ws.assets.filter((a) => !a.hidden).map((a) => a.placement);
    void createRepairedPreviewBlob(img, placements)
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setCutoutUrl(createdUrl);
      })
      .catch(() => {
        if (!cancelled) showToast('挖洞预览生成失败', 'error');
      })
      .finally(() => {
        if (!cancelled) setCutoutLoading(false);
      });

    return () => {
      cancelled = true;
      // 组件卸载/依赖变化时释放上一张，避免 objectURL 泄漏。
      // 同时把 state 清空：URL 已被 revoke，留着它会在下次进入挖洞模式时先渲染一张失效图。
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      setCutoutUrl(null);
    };
  }, [viewMode, visibleGeometryKey, sourceUrl, showToast]);

  // 注意：清空 cutoutUrl 放在上面 effect 的 cleanup 里，而不是再写一个
  // `if (viewMode !== 'cutout') setCutoutUrl(null)` 的 effect —— 那样会在 effect 体内同步 setState
  // （违反 react-hooks/set-state-in-effect）并多一轮渲染。

  /** 置于顶层/底层：assets 数组顺序即层级，末尾在上。 */
  const handleReorderZ = useCallback(
    (ids: string[], to: 'front' | 'back') => {
      if (ids.length === 0) return;
      const set = new Set(ids);
      void commit(to === 'front' ? '置于顶层' : '置于底层', (draft) => {
        const moved = draft.assets.filter((a) => set.has(a.id));
        const rest = draft.assets.filter((a) => !set.has(a.id));
        draft.assets = to === 'front' ? [...rest, ...moved] : [...moved, ...rest];
      });
    },
    [commit],
  );

  /** 切图上右键：选中它（若未选中）并在光标处打开菜单。 */
  const handleOverlayContextMenu = (e: React.PointerEvent | React.MouseEvent, asset: SliceAsset) => {
    e.preventDefault();
    e.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    setSelectedIds((prev) => (prev.has(asset.id) ? prev : new Set([asset.id])));
    setContextMenu({ x: e.clientX, y: e.clientY, assetId: asset.id });
  };

  // ===== 键盘快捷键 =====

  /** 方向键微调：整体位移并夹取在画布内，停止后重裁剪。 */
  const handleNudge = useCallback(
    (dx: number, dy: number) => {
      const ws = useSliceStore.getState().activeWorkspace;
      if (!ws || selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      void (async () => {
        // 同一 mergeKey：连按方向键合并为一条历史
        await mergeCommit(`nudge:${ids.join(',')}`, '移动切图', (draft) => {
          for (const a of draft.assets) {
            if (selectedIds.has(a.id)) a.placement = movePlacement(a.placement, dx, dy, draft.screen);
          }
        });
        scheduleRecrop(ids);
      })();
    },
    [mergeCommit, scheduleRecrop, selectedIds],
  );

  /** Alt+方向键：改变宽高（拖右下角的等价操作）。 */
  const handleResizeBy = useCallback(
    (dw: number, dh: number) => {
      const ws = useSliceStore.getState().activeWorkspace;
      if (!ws || selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      void (async () => {
        await mergeCommit(`resize:${ids.join(',')}`, '缩放切图', (draft) => {
          for (const a of draft.assets) {
            if (!selectedIds.has(a.id)) continue;
            a.placement = resizePlacement(a.placement, 'se', dw, dh, draft.screen, MIN_SLICE_SIZE);
          }
        });
        scheduleRecrop(ids);
      })();
    },
    [mergeCommit, scheduleRecrop, selectedIds],
  );

  const handleSelectAll = useCallback(() => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws) return;
    setSelectedIds(new Set(ws.assets.map((a) => a.id)));
  }, []);

  /** 复制到内部剪贴板（不走系统剪贴板：切图是 Blob 引用，无法直接序列化）。 */
  const handleCopySelection = useCallback(() => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws || selectedIds.size === 0) return;
    clipboardRef.current = ws.assets.filter((a) => selectedIds.has(a.id)).map((a) => structuredClone(a));
    showToast(`已复制 ${clipboardRef.current.length} 个切图`, 'info');
  }, [selectedIds, showToast]);

  /** 粘贴：偏移 10px，名称去重，Blob 深拷贝。 */
  const handlePaste = useCallback(async () => {
    const source = clipboardRef.current;
    if (source.length === 0) return;
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws) return;
    try {
      const copies = await Promise.all(source.map((a) => copyAssetDeep(a, ws.assets)));
      const shifted = copies.map((a) => ({
        ...a,
        placement: movePlacement(a.placement, PASTE_OFFSET, PASTE_OFFSET, ws.screen),
      }));
      await commit(shifted.length > 1 ? `粘贴 ${shifted.length} 个切图` : '粘贴切图', (draft) => {
        draft.assets.push(...shifted);
      });
      setSelectedIds(new Set(shifted.map((a) => a.id)));
    } catch {
      showToast('粘贴失败', 'error');
    }
  }, [commit, showToast]);

  /** Ctrl+D：原地复制选中项。 */
  const handleDuplicate = useCallback(async () => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws || selectedIds.size === 0) return;
    const targets = ws.assets.filter((a) => selectedIds.has(a.id));
    try {
      const copies = await Promise.all(targets.map((a) => copyAssetDeep(a, ws.assets)));
      const shifted = copies.map((a) => ({
        ...a,
        placement: movePlacement(a.placement, PASTE_OFFSET, PASTE_OFFSET, ws.screen),
      }));
      await commit(shifted.length > 1 ? `复制 ${shifted.length} 个切图` : '复制切图', (draft) => {
        draft.assets.push(...shifted);
      });
      setSelectedIds(new Set(shifted.map((a) => a.id)));
    } catch {
      showToast('复制失败', 'error');
    }
  }, [commit, selectedIds, showToast]);

  const handleToggleHiddenSelection = useCallback(() => {
    if (selectedIds.size === 0) return;
    void commit('切换显隐', (draft) => {
      const allHidden = draft.assets.filter((a) => selectedIds.has(a.id)).every((a) => a.hidden);
      for (const a of draft.assets) {
        if (selectedIds.has(a.id)) a.hidden = !allHidden;
      }
    });
  }, [commit, selectedIds]);

  const keyboard = useSliceKeyboard({
    onUndo: () => void undo(),
    onRedo: () => void redo(),
    onDelete: () => {
      if (selectedIds.size > 0) handleDeleteAssets(Array.from(selectedIds));
    },
    onNudge: handleNudge,
    onResizeBy: handleResizeBy,
    onSelectAll: handleSelectAll,
    onCopy: handleCopySelection,
    onPaste: () => void handlePaste(),
    onDuplicate: () => void handleDuplicate(),
    onEscape: () => {
      // 依次收起：设置抽屉 → 框选工具 → 选中态
      if (settingsAssetId !== null) setSettingsAssetId(null);
      else if (tool === 'draw') setTool('select');
      else setSelectedIds(new Set());
    },
    onSetTool: setTool,
    onZoom: (mode) => (mode === 'fit' ? fitToScreen() : setZoomCentered(1)),
    onToggleHidden: handleToggleHiddenSelection,
    onSpaceChange: (pressed) => {
      spaceHeldRef.current = pressed;
      setSpaceHeld(pressed);
    },
  });

  // ===== 派生值 =====
  const assets = activeWorkspace?.assets ?? [];
  const allHidden = assets.length > 0 && assets.every((a) => a.hidden);
  const allTransparent = assets.length > 0 && assets.every((a) => isProcessOpActive(a, 'transparent'));
  const allSvg = assets.length > 0 && assets.every((a) => isProcessOpActive(a, 'svg'));
  const inpaintAsset = inpaintAssetId
    ? assets.find((a) => a.id === inpaintAssetId) ?? null
    : null;
  // 属性面板的编辑对象：当前全部选中项（顺序与 assets 一致，便于批量编辑时展示稳定）
  const selectedAssets = assets.filter((a) => selectedIds.has(a.id));
  const contextMenuAsset = contextMenu
    ? assets.find((a) => a.id === contextMenu.assetId) ?? null
    : null;
  // 右键作用范围：命中项在选中集合内则作用于整个选中集合，否则只作用于命中项
  const contextMenuTargetIds = contextMenu
    ? selectedIds.has(contextMenu.assetId)
      ? Array.from(selectedIds)
      : [contextMenu.assetId]
    : [];

  if (!activeWorkspace) {
    return (
      <div className="grid h-full min-h-[60vh] place-items-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground">
        加载工作区中…
      </div>
    );
  }

  const naturalW = activeWorkspace.screen.width;
  const naturalH = activeWorkspace.screen.height;

  return (
    <div
      ref={rootRef}
      // tabIndex + 容器级 onKeyDown：把快捷键作用域限定在切图编辑器内，
      // 避免与「无限画布」Tab 的 window 级监听互相抢占（所有 Tab 都是 keepMounted）。
      tabIndex={-1}
      onKeyDown={keyboard.onKeyDown}
      onKeyUp={keyboard.onKeyUp}
      onBlur={keyboard.onBlur}
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card outline-none"
    >
      {/* 顶部工具栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void undo()}
          disabled={!canUndo}
          title={undoLabel ? `撤销：${undoLabel}` : '撤销 (Ctrl+Z)'}
          aria-label="撤销"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void redo()}
          disabled={!canRedo}
          title={redoLabel ? `重做：${redoLabel}` : '重做 (Ctrl+Shift+Z)'}
          aria-label="重做"
        >
          <Redo2 className="size-4" />
        </Button>
        <div className="h-4 w-px bg-border" />
        <Button onClick={handleDecompose} disabled={isDecomposing} size="sm">
          {isDecomposing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
          {isDecomposing ? `AI 拆图中 ${decomposeElapsed}s` : 'AI 拆图'}
        </Button>
        {isDecomposing && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => decomposeAbortRef.current?.abort()}
            title="取消本次 AI 拆图"
          >
            取消
          </Button>
        )}
        {/* 图片模型选择器（仅 AI 透明化 / 背景补齐使用） */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <span className="max-w-[10rem] truncate">
                {describeSliceImageModel(settings.model)}
              </span>
              <ChevronDown className="size-3.5 opacity-70" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1" align="start">
            <SliceImageModelPicker value={settings.model} onSelect={handleModelSelect} />
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex items-center gap-1">
          {/* 查看模式切换：解决"看不出框选是否准确"的核心可视化问题 */}
          <div className="flex items-center rounded-md border border-border p-0.5">
            {VIEW_MODE_OPTIONS.map((option) => (
              <Button
                key={option.value}
                variant={viewMode === option.value ? 'secondary' : 'ghost'}
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setViewMode(option.value)}
                title={option.hint}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <div className="h-4 w-px bg-border" />
          {/*
            批量入口只给算法类操作（透明 / SVG）：两者纯本地计算，不消耗额度。
            AI 透明与 AI SVG 会逐张扣费，只在资产行内提供单个入口。
          */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleBatchLocalOp('transparent')}
            disabled={assets.length === 0 || processBusy}
            aria-pressed={allTransparent}
            title={
              allTransparent
                ? '还原全部切图的透明化结果'
                : '用本地算法移除纯色背景，不消耗 AI 额度'
            }
          >
            {processBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : allTransparent ? (
              <RotateCcw className="size-3.5" />
            ) : (
              <Square className="size-3.5" />
            )}
            {allTransparent ? '全部还原透明' : '全部透明'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleBatchLocalOp('svg')}
            disabled={assets.length === 0 || processBusy}
            aria-pressed={allSvg}
            title={
              allSvg
                ? '还原全部切图的矢量化结果'
                : '用本地算法把切图追踪为可编辑 SVG，不消耗 AI 额度'
            }
          >
            {processBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : allSvg ? (
              <RotateCcw className="size-3.5" />
            ) : (
              <Shapes className="size-3.5" />
            )}
            {allSvg ? '全部还原 SVG' : '全部转 SVG'}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleBatchToggleHidden} disabled={assets.length === 0}>
            {allHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            {allHidden ? '全部显示' : '全部隐藏'}
          </Button>
          {/*
            原「预览补齐」按钮已移除：它只弹一个 toast，不产生任何图像。
            其真实能力（本地边缘混合补丁预览抠图后的背景）已由「挖洞」查看模式提供。
          */}
          <div className="h-4 w-px bg-border" />
          <Button
            variant={tool === 'draw' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setTool(tool === 'draw' ? 'select' : 'draw')}
            title="框选切图"
          >
            {tool === 'draw' ? <Square className="size-3.5" /> : <MousePointer2 className="size-3.5" />}
            {tool === 'draw' ? '框选中' : '框选'}
          </Button>
        </div>
      </div>

      {/* 主区：画布 + 侧栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 画布 */}
        <div
          ref={viewportRef}
          className={cn(
            'relative min-w-0 flex-1 select-none overflow-hidden bg-muted/30',
            spaceHeld
              ? 'cursor-grab active:cursor-grabbing'
              : tool === 'draw'
                ? 'cursor-crosshair'
                : 'cursor-grab active:cursor-grabbing',
          )}
          onPointerDown={handleViewportPointerDown}
          onAuxClick={(e) => e.preventDefault()}
          onPointerDownCapture={handleViewportAuxPointerDown}
          onContextMenu={(e) => {
            // 空白处右键：关掉菜单并阻止浏览器菜单，避免遮挡画布
            e.preventDefault();
            setContextMenu(null);
          }}
        >
          <div
            className="pointer-events-none absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
          >
            {/* 底图层：按查看模式切换 */}
            {viewMode === 'slices' ? (
              // 棋盘底，凸显切图的透明区域
              <div
                className="pointer-events-none block"
                style={{
                  width: naturalW,
                  height: naturalH,
                  backgroundColor: '#fff',
                  backgroundImage:
                    'linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%),' +
                    'linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%)',
                  backgroundSize: '16px 16px',
                  backgroundPosition: '0 0, 8px 8px',
                }}
              />
            ) : (
              (viewMode === 'cutout' ? cutoutUrl : sourceUrl) && (
                <img
                  src={(viewMode === 'cutout' ? cutoutUrl : sourceUrl) as string}
                  alt={viewMode === 'cutout' ? '挖洞预览' : '源图'}
                  className="pointer-events-none block"
                  style={{ width: naturalW, height: naturalH, maxWidth: 'none' }}
                  draggable={false}
                />
              )
            )}

            {/* 仅切图模式：把每个切图的实际内容画到它的位置上 */}
            {viewMode === 'slices' &&
              assets
                .filter((a) => !a.hidden)
                .map((asset) => (
                  <SliceContentLayer
                    key={asset.id}
                    asset={asset}
                    placement={drafts[asset.id] ?? asset.placement}
                    screen={activeWorkspace.screen}
                  />
                ))}

            {assets.map((asset) => (
              <SliceOverlay
                key={asset.id}
                asset={asset}
                placement={drafts[asset.id] ?? asset.placement}
                selected={selectedIds.has(asset.id)}
                zoom={zoom}
                screen={activeWorkspace.screen}
                radiusDraft={
                  radiusDraft && radiusDraft.assetId === asset.id
                    ? { corner: radiusDraft.corner, value: radiusDraft.value }
                    : null
                }
                onStartMove={handleStartMove}
                onStartResize={handleStartResize}
                onStartRadius={handleStartRadius}
                onContextMenu={handleOverlayContextMenu}
              />
            ))}
            {drawDraft && (
              <div
                className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
                style={{
                  left: drawDraft.x,
                  top: drawDraft.y,
                  width: drawDraft.width,
                  height: drawDraft.height,
                }}
              />
            )}
            {/* 框选多选矩形 */}
            {marquee && (
              <div
                className="pointer-events-none absolute border border-primary bg-primary/10"
                style={{
                  left: marquee.x,
                  top: marquee.y,
                  width: marquee.width,
                  height: marquee.height,
                }}
              />
            )}
            {/* 吸附辅助线 */}
            {snapGuides.map((guide, index) => (
              <div
                key={`${guide.axis}-${guide.position}-${index}`}
                className="pointer-events-none absolute bg-pink-500"
                style={
                  guide.axis === 'x'
                    ? { left: guide.position, top: 0, width: 1 / zoom, height: naturalH }
                    : { left: 0, top: guide.position, width: naturalW, height: 1 / zoom }
                }
              />
            ))}
          </div>

          {viewMode === 'cutout' && cutoutLoading && (
            <div className="absolute right-3 top-3 rounded-md border border-border bg-background/95 px-2 py-1 text-xs text-muted-foreground shadow-sm">
              正在生成挖洞预览…
            </div>
          )}

          {isDecomposing && (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-20 md:left-auto md:w-[min(34rem,calc(100%-1.5rem))]">
              <StreamingCodePanel
                className="pointer-events-auto"
                title="AI 拆图流"
                language="JSON"
                text={decomposeStreamText}
                phase={decomposeStreamPhase}
                elapsed={decomposeElapsed}
                isStreaming
                maxHeight="min(38vh, 24rem)"
              />
            </div>
          )}

          {/* 缩放控制 */}
          <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm">
            <Button size="icon-sm" variant="ghost" onClick={() => zoomAt(1 / 1.2)} title="缩小">
              <ZoomOut className="size-4" />
            </Button>
            <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(zoom * 100)}%
            </span>
            <Button size="icon-sm" variant="ghost" onClick={() => zoomAt(1.2)} title="放大">
              <ZoomIn className="size-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={() => setZoomCentered(1)} title="100%">
              <span className="text-[10px]">1:1</span>
            </Button>
            <Button size="icon-sm" variant="ghost" onClick={fitToScreen} title="适应画布">
              <Maximize className="size-4" />
            </Button>
          </div>

          {!sourceUrl && (
            <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
              源图加载中…
            </div>
          )}
        </div>

        {/* 右侧资产列表 + 常驻属性面板 */}
        <aside className="flex h-full min-h-0 w-72 shrink-0 flex-col border-l border-border bg-card">
          <div className="min-h-0 flex-1 overflow-hidden">
            <SliceAssetPanel
              workspace={activeWorkspace}
              selectedIds={selectedIds}
              onSelect={handleSelect}
              onCopy={handleCopyAsset}
              onDelete={handleDeleteAssets}
              onOpenSettings={(id) => setSelectedIds(new Set([id]))}
              onToggleHidden={handleToggleHidden}
              onReorder={handleReorder}
              onRunOp={(op, id) => {
                // AI 类逐个执行；算法类走批量通道但只传一个 id
                if (op === 'aiTransparent' || op === 'aiSvg') void handleAiOp(op, id);
                else void handleLocalOp(op, [id]);
              }}
              onRestoreOp={(op, id) => handleRestoreOp(op, [id])}
              onOpenInpaint={(id) => setInpaintAssetId(id)}
              processBusy={processBusy}
              aiOp={aiOp}
              onCancelAiOp={() => aiOpAbortRef.current?.abort()}
            />
          </div>
          {/* 属性面板常驻在列表下方，不再用弹窗遮挡画布 */}
          <div className="max-h-[52%] shrink-0 overflow-y-auto">
            <SlicePropertyPanel
              selected={selectedAssets}
              screen={activeWorkspace.screen}
              onUpdate={handleUpdateAssets}
              onRecrop={(ids) => void recropAssets(ids)}
              onOpenInpaint={(id) => setInpaintAssetId(id)}
              onTransparent={(ids) => void handleMakeTransparent(ids)}
              onRestoreTransparency={handleRestoreTransparency}
              transparencyBusy={processBusy}
            />
          </div>
        </aside>
      </div>

      {/* AI 补齐编辑器 */}
      <SliceInpaintEditor
        asset={inpaintAsset}
        open={inpaintAssetId !== null}
        onOpenChange={(open: boolean) => !open && setInpaintAssetId(null)}
        model={settings.model}
        onSaved={handleInpaintSaved}
        onConfigureApiKey={onConfigureApiKey}
        showToast={showToast}
      />

      {/* AI 拆图结果确认 */}
      <DecomposeReviewDialog
        open={decomposeDialogOpen}
        onOpenChange={(o) => {
          if (!o) {
            setDecomposeDialogOpen(false);
            setDecomposeCandidates([]);
            // 用户放弃本批切图，但背景候选仍然值得处理
            if (pendingBackgrounds) {
              setPendingBackgrounds(false);
              setBackgroundDialogOpen(true);
            }
          }
        }}
        candidates={decomposeCandidates}
        existingCount={assets.length}
        onConfirm={handleConfirmDecompose}
      />

      {/* 背景确认弹窗 */}
      <BackgroundConfirmDialog        open={backgroundDialogOpen}
        onOpenChange={setBackgroundDialogOpen}
        sourceImageUrl={sourceUrl}
        naturalSize={{ width: naturalW, height: naturalH }}
        candidates={backgroundCandidates}
        model={settings.model}
        getSourceImg={() => sourceImgRef.current}
        onConfigureApiKey={onConfigureApiKey}
        showToast={showToast}
        onGenerated={handleBackgroundGenerated}
      />

      {/* 切图右键菜单 */}
      {contextMenu && contextMenuAsset && (
        <SliceContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          hidden={contextMenuAsset.hidden}
          selectedCount={selectedIds.size}
          onClose={() => setContextMenu(null)}
          onOpenSettings={() => setSettingsAssetId(contextMenu.assetId)}
          onInpaint={() => setInpaintAssetId(contextMenu.assetId)}
          onDuplicate={() => void handleDuplicate()}
          onToggleHidden={handleToggleHiddenSelection}
          onBringToFront={() => handleReorderZ(contextMenuTargetIds, 'front')}
          onSendToBack={() => handleReorderZ(contextMenuTargetIds, 'back')}
          transparent={contextMenuAsset.transparent}
          onTransparent={() => void handleMakeTransparent(contextMenuTargetIds)}
          onRestoreTransparency={() => handleRestoreTransparency(contextMenuTargetIds)}
          onDelete={() => handleDeleteAssets(contextMenuTargetIds)}
        />
      )}

      {/* 破坏性调整确认：调整已处理的切图会作废透明 / SVG 结果 */}
      <Dialog
        open={processResetPrompt !== null}
        onOpenChange={(open) => {
          // 点遮罩或按 Esc 关闭 = 不同意，保留处理结果
          if (!open) settleProcessResetPrompt(false);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>调整切图将取消已有处理</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            {processResetPrompt?.assets.slice(0, 5).map((asset) => (
              <p key={asset.id}>{describeProcessResetMessage(asset)}</p>
            ))}
            {(processResetPrompt?.assets.length ?? 0) > 5 && (
              <p>等共 {processResetPrompt?.assets.length} 个切图。</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => settleProcessResetPrompt(false)}>
              保留处理结果
            </Button>
            <Button variant="destructive" onClick={() => settleProcessResetPrompt(true)}>
              继续调整
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 「仅切图」模式下渲染单个切图的实际内容。
 *
 * 与被移除的旧叠加层的区别：这里只在 slices 模式出现，用户明确知道看的是切图内容而非源图；
 * 且用 object-contain 而不是 fill，尺寸不匹配时留白而不是拉伸变形。
 */
function SliceContentLayer({
  asset,
  placement,
  screen,
}: {
  asset: SliceAsset;
  placement: SlicePlacement;
  screen: SliceScreen;
}) {
  const url = useBlobUrl(asset.currentBlobKey);
  if (!url) return null;
  const radii = getSliceRadii(asset, screen);
  return (
    <img
      src={url}
      alt={asset.name}
      className="pointer-events-none absolute"
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
        objectFit: 'contain',
        borderRadius: `${radii.topLeft}px ${radii.topRight}px ${radii.bottomRight}px ${radii.bottomLeft}px`,
      }}
      draggable={false}
    />
  );
}

/** 画布上的单个切图框选叠加层 */
interface SliceOverlayProps {
  asset: SliceAsset;
  placement: SlicePlacement;
  selected: boolean;
  zoom: number;
  screen: SliceScreen;
  /** 圆角拖拽中的临时值，仅对当前被拖的那个角生效 */
  radiusDraft?: { corner: SliceRadiusCorner; value: number } | null;
  onStartMove: (e: React.PointerEvent, asset: SliceAsset) => void;
  onStartResize: (e: React.PointerEvent, asset: SliceAsset, handle: ResizeHandle) => void;
  onStartRadius: (e: React.PointerEvent, asset: SliceAsset, corner: SliceRadiusCorner) => void;
  onContextMenu: (e: React.MouseEvent, asset: SliceAsset) => void;
}

function SliceOverlay({
  asset,
  placement,
  selected,
  zoom,
  screen,
  radiusDraft,
  onStartMove,
  onStartResize,
  onStartRadius,
  onContextMenu,
}: SliceOverlayProps) {
  // 手柄尺寸随缩放反向调整，保持屏幕上视觉一致
  const handleSize = Math.max(5, Math.min(14, 8 / zoom));
  const baseRadii = getSliceRadii({ ...asset, placement }, screen);
  const radii = radiusDraft
    ? { ...baseRadii, [radiusDraft.corner]: radiusDraft.value }
    : baseRadii;
  const borderRadius = `${radii.topLeft}px ${radii.topRight}px ${radii.bottomRight}px ${radii.bottomLeft}px`;

  return (
    <div
      className={cn(
        'pointer-events-auto absolute box-border',
        selected ? 'z-10 border-2 border-primary bg-primary/5' : 'border-2 border-blue-500',
        asset.hidden ? 'opacity-40' : 'opacity-100',
      )}
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.width,
        height: placement.height,
        borderRadius,
        cursor: 'move',
      }}
      onPointerDown={(e) => onStartMove(e, asset)}
      onContextMenu={(e) => onContextMenu(e, asset)}
    >
      {/*
        这里刻意不再把 asset.currentBlobKey 的裁剪图以 object-fit: fill 叠回源图。
        叠加会完全遮住源图，且在框刚被拖动、重裁剪尚未落地的那一瞬间显示为拉伸图像，
        用户根本无法判断框选是否准确。要看切图内容请切到「仅切图」查看模式。
      */}
      <span className="pointer-events-none absolute -top-5 left-0 max-w-full truncate bg-blue-500 px-1 text-[10px] leading-4 text-white">
        {asset.name}
      </span>
      {selected && (
        <>
          {RESIZE_HANDLES.map((h) => (
            <span
              key={h}
              onPointerDown={(e) => onStartResize(e, asset, h)}
              className="pointer-events-auto absolute border border-white bg-primary"
              style={{
                width: handleSize,
                height: handleSize,
                cursor: handleCursor(h),
                ...handlePosition(h),
              }}
            />
          ))}
          {/* 四角圆角手柄：向内拖动增大圆角。用圆形与方形缩放手柄区分。 */}
          {SLICE_RADIUS_CORNERS.map((corner) => (
            <span
              key={corner}
              onPointerDown={(e) => onStartRadius(e, asset, corner)}
              title="拖动调整圆角"
              className="pointer-events-auto absolute rounded-full border border-primary bg-white"
              style={{
                width: handleSize,
                height: handleSize,
                cursor: 'crosshair',
                ...radiusHandlePosition(corner, handleSize),
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/**
 * 圆角手柄的位置：沿对角线向内缩进，避开同角的缩放手柄。
 * 缩进量取手柄尺寸的 1.6 倍，同时不超过短边的 1/4，防止小框上手柄互相重叠。
 */
function radiusHandlePosition(corner: SliceRadiusCorner, handleSize: number): React.CSSProperties {
  const inset = handleSize * 1.6;
  switch (corner) {
    case 'topLeft':
      return { left: inset, top: inset, transform: 'translate(-50%, -50%)' };
    case 'topRight':
      return { right: inset, top: inset, transform: 'translate(50%, -50%)' };
    case 'bottomRight':
      return { right: inset, bottom: inset, transform: 'translate(50%, 50%)' };
    case 'bottomLeft':
    default:
      return { left: inset, bottom: inset, transform: 'translate(-50%, 50%)' };
  }
}
