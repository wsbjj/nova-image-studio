'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, Maximize, Redo2, Sparkles, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { nanoid } from 'nanoid';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { putBlob } from '@/lib/slice-db';
import { type DecompositionResult } from '@/lib/slice-ai-client';
import { runSliceInpaint } from '@/lib/slice-inpaint';
import { renderSliceBlob } from '@/lib/slice-crop';
import {
  MIN_SLICE_SIZE,
  RESIZE_HANDLES,
  clampNumber,
  movePlacement,
  normalizeSlicePlacement,
  resizePlacement,
  type ResizeHandle,
} from '@/lib/slice-geometry';
import { hasSliceImageModel } from '@/lib/slice-model-config';
import type { SliceAsset, SlicePlacement, SliceScreen } from '@/lib/slice-types';

/** 弹窗内的可编辑评审模型（与 AI 返回结构解耦，便于撤销与逐项开关）。 */
interface ReviewOverlay {
  id: string;
  name: string;
  kind: string;
  bbox: SlicePlacement;
  /** 是否纳入移除（即需要 AI 重建） */
  remove: boolean;
}

interface ReviewBackground {
  id: string;
  name: string;
  bbox: SlicePlacement;
  reason: string;
  bakedVisuals: string[];
  enabled: boolean;
  overlays: ReviewOverlay[];
}

/** 弹窗内独立历史栈上限（源项目为 100）。 */
const REVIEW_HISTORY_LIMIT = 100;

/**
 * 由 AI 结果构造评审模型。
 *
 * overlay 默认勾选规则：**只有 code-overlay 默认移除**。
 * 移植版把所有 overlay 默认纳入移除，会把独立位图（raster-overlay）一起抹掉 —— 这是可控性缺陷 B10。
 */
function toReviewModel(candidates: DecompositionResult['backgrounds']): ReviewBackground[] {
  return candidates.map((bg) => ({
    id: bg.id,
    name: bg.name || '背景',
    bbox: { ...bg.bbox },
    reason: bg.reason,
    bakedVisuals: bg.bakedVisuals ?? [],
    enabled: true,
    overlays: bg.overlays.map((o) => ({
      id: o.id,
      name: o.name || '覆盖层',
      kind: o.kind,
      bbox: { ...o.bbox },
      remove: o.kind === 'code-overlay',
    })),
  }));
}

type DragState =
  | { kind: 'bg-move'; startClient: { x: number; y: number }; start: SlicePlacement }
  | { kind: 'bg-resize'; handle: ResizeHandle; startClient: { x: number; y: number }; start: SlicePlacement }
  | { kind: 'ov-move'; overlayId: string; startClient: { x: number; y: number }; start: SlicePlacement }
  | {
      kind: 'ov-resize';
      overlayId: string;
      handle: ResizeHandle;
      startClient: { x: number; y: number };
      start: SlicePlacement;
    };

interface BackgroundConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceImageUrl: string | null;
  naturalSize: SliceScreen;
  candidates: DecompositionResult['backgrounds'];
  model: string;
  getSourceImg: () => HTMLImageElement | null;
  onConfigureApiKey: () => void;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  onGenerated: (assets: SliceAsset[]) => void;
}

/**
 * 背景确认弹窗（可编辑版）。
 *
 * 相比移植版的只读勾选，这里补回了源项目的可控性：
 * - 蓝框（背景范围）与红框（移除区域）都能拖动、8 向缩放、方向键微调
 * - 一次只渲染当前候选，用「上一个/下一个」切换，避免多候选叠框成一团
 * - 视图可缩放平移，展示 bakedVisuals（会写进补齐提示词的保留内容）
 * - 弹窗内**独立**撤销栈（Ctrl+Z / Ctrl+Shift+Z），不与主编辑器历史混用
 * - 生成过程可取消，已完成的背景保留
 */
export function BackgroundConfirmDialog({
  open,
  onOpenChange,
  sourceImageUrl,
  naturalSize,
  candidates,
  model,
  getSourceImg,
  onConfigureApiKey,
  showToast,
  onGenerated,
}: BackgroundConfirmDialogProps) {
  const [items, setItems] = useState<ReviewBackground[]>(() => toReviewModel(candidates));
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // 弹窗内独立历史栈
  const [past, setPast] = useState<ReviewBackground[][]>([]);
  const [future, setFuture] = useState<ReviewBackground[][]>([]);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const zoomRef = useRef(1);
  const offsetRef = useRef({ x: 0, y: 0 });
  const abortRef = useRef<AbortController | null>(null);
  const itemsRef = useRef(items);

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { offsetRef.current = offset; }, [offset]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // candidates 变化（重新拆图）时重建评审模型并清空历史。
  // 用"渲染期根据 prop 变化调整 state"而非 useEffect + setState：后者会多一轮渲染，
  // 且触发 react-hooks/set-state-in-effect。
  const [lastCandidates, setLastCandidates] = useState(candidates);
  if (candidates !== lastCandidates) {
    setLastCandidates(candidates);
    setItems(toReviewModel(candidates));
    setActiveIndex(0);
    setSelectedOverlayId(null);
    setPast([]);
    setFuture([]);
  }

  const active = items[activeIndex] ?? null;

  /** 记一条历史后修改评审模型。 */
  const commit = useCallback((updater: (draft: ReviewBackground[]) => void) => {
    setItems((prev) => {
      const snapshot = structuredClone(prev);
      setPast((p) => {
        const next = [...p, snapshot];
        return next.length > REVIEW_HISTORY_LIMIT ? next.slice(next.length - REVIEW_HISTORY_LIMIT) : next;
      });
      setFuture([]);
      const draft = structuredClone(prev);
      updater(draft);
      return draft;
    });
  }, []);

  /** 拖拽过程中的静默更新（历史已在手势开始时记过）。 */
  const applySilent = useCallback((updater: (draft: ReviewBackground[]) => void) => {
    setItems((prev) => {
      const draft = structuredClone(prev);
      updater(draft);
      return draft;
    });
  }, []);

  const beginGesture = useCallback(() => {
    setItems((prev) => {
      const snapshot = structuredClone(prev);
      setPast((p) => {
        const next = [...p, snapshot];
        return next.length > REVIEW_HISTORY_LIMIT ? next.slice(next.length - REVIEW_HISTORY_LIMIT) : next;
      });
      setFuture([]);
      return prev;
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const entry = p[p.length - 1];
      setFuture((f) => [...f, structuredClone(itemsRef.current)]);
      setItems(entry);
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const entry = f[f.length - 1];
      setPast((p) => [...p, structuredClone(itemsRef.current)]);
      setItems(entry);
      return f.slice(0, -1);
    });
  }, []);

  // ===== 视图 =====
  const fitToScreen = useCallback(() => {
    const el = viewportRef.current;
    if (!el || !naturalSize.width || !naturalSize.height) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const z = Math.min(rect.width / naturalSize.width, rect.height / naturalSize.height) * 0.95;
    const off = {
      x: (rect.width - naturalSize.width * z) / 2,
      y: (rect.height - naturalSize.height * z) / 2,
    };
    zoomRef.current = z;
    offsetRef.current = off;
    setZoom(z);
    setOffset(off);
  }, [naturalSize.width, naturalSize.height]);

  useEffect(() => {
    if (!open) return;
    // 等 Dialog 完成布局后再计算适应缩放
    const id = requestAnimationFrame(() => fitToScreen());
    return () => cancelAnimationFrame(id);
  }, [open, fitToScreen]);

  const zoomBy = (factor: number) => {
    const next = clampNumber(zoomRef.current * factor, 0.05, 8, zoomRef.current);
    zoomRef.current = next;
    setZoom(next);
  };

  // ===== 拖拽 =====
  useEffect(() => {
    if (!open) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      e.preventDefault();
      const dx = (e.clientX - drag.startClient.x) / zoomRef.current;
      const dy = (e.clientY - drag.startClient.y) / zoomRef.current;

      applySilent((draft) => {
        const bg = draft[activeIndex];
        if (!bg) return;
        if (drag.kind === 'bg-move') {
          bg.bbox = movePlacement(drag.start, dx, dy, naturalSize);
        } else if (drag.kind === 'bg-resize') {
          bg.bbox = resizePlacement(drag.start, drag.handle, dx, dy, naturalSize, MIN_SLICE_SIZE);
        } else {
          const ov = bg.overlays.find((o) => o.id === drag.overlayId);
          if (!ov) return;
          // 覆盖层坐标是绝对坐标，同样夹取在画布内
          ov.bbox =
            drag.kind === 'ov-move'
              ? movePlacement(drag.start, dx, dy, naturalSize)
              : resizePlacement(drag.start, drag.handle, dx, dy, naturalSize, MIN_SLICE_SIZE);
        }
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [open, activeIndex, applySilent, naturalSize]);

  // ===== 键盘（作用域限定在弹窗内） =====
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const editing =
      e.target instanceof HTMLInputElement ||
      e.target instanceof HTMLTextAreaElement ||
      (e.target instanceof HTMLElement && e.target.isContentEditable);

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (editing) return;

    // 方向键微调当前选中的覆盖层
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (arrows[e.key] && selectedOverlayId) {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 10 : 1;
      const [ux, uy] = arrows[e.key];
      commit((draft) => {
        const ov = draft[activeIndex]?.overlays.find((o) => o.id === selectedOverlayId);
        if (ov) ov.bbox = movePlacement(ov.bbox, ux * step, uy * step, naturalSize);
      });
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedOverlayId) {
      e.preventDefault();
      e.stopPropagation();
      commit((draft) => {
        const ov = draft[activeIndex]?.overlays.find((o) => o.id === selectedOverlayId);
        if (ov) ov.remove = false;
      });
    }
  };

  // ===== 生成 =====
  const handleGenerate = async () => {
    if (!hasSliceImageModel()) {
      showToast('背景补齐需要一个 OpenAI 协议的图片模型，请先在设置中添加', 'error');
      onConfigureApiKey();
      return;
    }
    const sourceImg = getSourceImg();
    if (!sourceImg) {
      showToast('源图尚未加载完成，请稍后重试', 'error');
      return;
    }
    const targets = items.filter((b) => b.enabled && b.overlays.some((o) => o.remove));
    if (targets.length === 0) {
      showToast('请至少启用一个背景，并保留至少一个移除区域', 'info');
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setProgress({ done: 0, total: targets.length });

    const created: SliceAsset[] = [];
    try {
      for (let i = 0; i < targets.length; i += 1) {
        if (controller.signal.aborted) break;
        const bg = targets[i];
        setProgress({ done: i, total: targets.length });

        const bbox = normalizeSlicePlacement(bg.bbox, naturalSize, MIN_SLICE_SIZE);
        const baseBlob = await renderSliceBlob(sourceImg, bbox, null);

        // overlay 是绝对坐标，转成背景局部坐标并裁到背景范围内
        const regions: SlicePlacement[] = [];
        for (const ov of bg.overlays) {
          if (!ov.remove) continue;
          const x1 = Math.max(bbox.x, ov.bbox.x);
          const y1 = Math.max(bbox.y, ov.bbox.y);
          const x2 = Math.min(bbox.x + bbox.width, ov.bbox.x + ov.bbox.width);
          const y2 = Math.min(bbox.y + bbox.height, ov.bbox.y + ov.bbox.height);
          if (x2 - x1 < 1 || y2 - y1 < 1) continue; // 与背景无交集则跳过
          regions.push({ x: x1 - bbox.x, y: y1 - bbox.y, width: x2 - x1, height: y2 - y1 });
        }
        if (regions.length === 0) continue;

        const { composite, raw } = await runSliceInpaint({
          model,
          baseBlob,
          regions,
          width: bbox.width,
          height: bbox.height,
          assetName: bg.name,
          bakedVisuals: bg.bakedVisuals,
          signal: controller.signal,
        });

        const groupId = nanoid();
        const [compositeKey, rawKey] = await Promise.all([
          putBlob(composite, 'image/png'),
          putBlob(raw, 'image/png'),
        ]);

        // 产出两个资产供用户取舍，不替用户挑
        if (compositeKey) {
          created.push(makeBackgroundAsset(`${bg.name}_局部合成`, bbox, compositeKey, bg, groupId, 'composite'));
        }
        if (rawKey) {
          created.push(makeBackgroundAsset(`${bg.name}_AI原图`, bbox, rawKey, bg, groupId, 'raw'));
        }
      }

      if (created.length > 0) {
        onGenerated(created);
        showToast(
          controller.signal.aborted
            ? `已取消，保留已完成的 ${created.length / 2} 个背景`
            : `已生成 ${created.length / 2} 个背景（各含局部合成与 AI 原图）`,
          'success',
        );
        onOpenChange(false);
      } else if (!controller.signal.aborted) {
        showToast('未生成任何背景切图', 'info');
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // 用户主动取消：已完成的部分照样保留
        if (created.length > 0) {
          onGenerated(created);
          showToast(`已取消，保留已完成的 ${created.length / 2} 个背景`, 'info');
          onOpenChange(false);
        } else {
          showToast('已取消背景生成', 'info');
        }
      } else {
        showToast(err instanceof Error ? err.message : '背景生成失败', 'error');
      }
    } finally {
      abortRef.current = null;
      setGenerating(false);
      setProgress(null);
    }
  };

  const removeCount = items.reduce(
    (sum, b) => sum + (b.enabled ? b.overlays.filter((o) => o.remove).length : 0),
    0,
  );
  const enabledCount = items.filter((b) => b.enabled && b.overlays.some((o) => o.remove)).length;
  const handleSize = Math.max(6, Math.min(14, 9 / zoom));

  return (
    <Dialog open={open} onOpenChange={(o) => !generating && onOpenChange(o)}>
      <DialogContent
        className="flex max-h-[90vh] flex-col sm:max-w-5xl"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle>背景确认</DialogTitle>
        </DialogHeader>

        {items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">没有可用的背景候选</p>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            {/* 画布 */}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div
                ref={viewportRef}
                className="relative min-h-[320px] flex-1 overflow-hidden rounded-lg border border-border bg-muted/30"
              >
                <div
                  className="absolute left-0 top-0 origin-top-left"
                  style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
                >
                  {sourceImageUrl && (
                    <img
                      src={sourceImageUrl}
                      alt="源图"
                      className="pointer-events-none block"
                      style={{ width: naturalSize.width, height: naturalSize.height, maxWidth: 'none' }}
                      draggable={false}
                    />
                  )}
                  {active && (
                    <>
                      {/* 蓝框：背景范围 */}
                      <div
                        className={cn(
                          'absolute border-2 bg-blue-500/10',
                          active.enabled ? 'border-blue-500' : 'border-blue-500/30',
                        )}
                        style={{
                          left: active.bbox.x,
                          top: active.bbox.y,
                          width: active.bbox.width,
                          height: active.bbox.height,
                          cursor: 'move',
                        }}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || generating) return;
                          e.stopPropagation();
                          setSelectedOverlayId(null);
                          beginGesture();
                          dragRef.current = {
                            kind: 'bg-move',
                            startClient: { x: e.clientX, y: e.clientY },
                            start: { ...active.bbox },
                          };
                        }}
                      >
                        <span className="pointer-events-none absolute -top-5 left-0 bg-blue-500 px-1 text-[10px] leading-4 text-white">
                          {active.name}
                        </span>
                        {RESIZE_HANDLES.map((h) => (
                          <span
                            key={h}
                            className="absolute border border-white bg-blue-500"
                            style={{ width: handleSize, height: handleSize, cursor: 'nwse-resize', ...handleStyle(h) }}
                            onPointerDown={(e) => {
                              if (e.button !== 0 || generating) return;
                              e.stopPropagation();
                              beginGesture();
                              dragRef.current = {
                                kind: 'bg-resize',
                                handle: h,
                                startClient: { x: e.clientX, y: e.clientY },
                                start: { ...active.bbox },
                              };
                            }}
                          />
                        ))}
                      </div>

                      {/* 红框：移除区域（绝对坐标） */}
                      {active.overlays.map((ov) => (
                        <div
                          key={ov.id}
                          className={cn(
                            'absolute border border-dashed',
                            ov.remove ? 'border-red-500 bg-red-500/20' : 'border-red-300/40',
                            selectedOverlayId === ov.id && 'ring-2 ring-red-400',
                          )}
                          style={{
                            left: ov.bbox.x,
                            top: ov.bbox.y,
                            width: ov.bbox.width,
                            height: ov.bbox.height,
                            cursor: 'move',
                          }}
                          title={`${ov.name}（${ov.kind === 'code-overlay' ? '代码层' : '位图层'}）`}
                          onPointerDown={(e) => {
                            if (e.button !== 0 || generating) return;
                            e.stopPropagation();
                            setSelectedOverlayId(ov.id);
                            beginGesture();
                            dragRef.current = {
                              kind: 'ov-move',
                              overlayId: ov.id,
                              startClient: { x: e.clientX, y: e.clientY },
                              start: { ...ov.bbox },
                            };
                          }}
                        >
                          {selectedOverlayId === ov.id &&
                            RESIZE_HANDLES.map((h) => (
                              <span
                                key={h}
                                className="absolute border border-white bg-red-500"
                                style={{ width: handleSize, height: handleSize, cursor: 'nwse-resize', ...handleStyle(h) }}
                                onPointerDown={(e) => {
                                  if (e.button !== 0 || generating) return;
                                  e.stopPropagation();
                                  beginGesture();
                                  dragRef.current = {
                                    kind: 'ov-resize',
                                    overlayId: ov.id,
                                    handle: h,
                                    startClient: { x: e.clientX, y: e.clientY },
                                    start: { ...ov.bbox },
                                  };
                                }}
                              />
                            ))}
                        </div>
                      ))}
                    </>
                  )}
                </div>

                {/* 视图控制 */}
                <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm">
                  <Button size="icon-sm" variant="ghost" onClick={() => zoomBy(1 / 1.2)} title="缩小">
                    <ZoomOut className="size-4" />
                  </Button>
                  <span className="w-11 text-center text-xs tabular-nums text-muted-foreground">
                    {Math.round(zoom * 100)}%
                  </span>
                  <Button size="icon-sm" variant="ghost" onClick={() => zoomBy(1.2)} title="放大">
                    <ZoomIn className="size-4" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={fitToScreen} title="适应">
                    <Maximize className="size-4" />
                  </Button>
                </div>

                {/* 弹窗内独立撤销/重做 */}
                <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-border bg-background/95 p-1 shadow-sm">
                  <Button size="icon-sm" variant="ghost" onClick={undo} disabled={past.length === 0} title="撤销 (Ctrl+Z)">
                    <Undo2 className="size-4" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={redo} disabled={future.length === 0} title="重做 (Ctrl+Shift+Z)">
                    <Redo2 className="size-4" />
                  </Button>
                </div>
              </div>

              {/* 候选导航 */}
              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setActiveIndex((i) => Math.max(0, i - 1)); setSelectedOverlayId(null); }}
                  disabled={activeIndex === 0}
                >
                  <ChevronLeft className="size-4" />
                  上一个
                </Button>
                <span className="text-xs text-muted-foreground">
                  背景 {activeIndex + 1} / {items.length}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { setActiveIndex((i) => Math.min(items.length - 1, i + 1)); setSelectedOverlayId(null); }}
                  disabled={activeIndex >= items.length - 1}
                >
                  下一个
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </div>

            {/* 右侧属性 */}
            <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border pl-3">
              {active && (
                <>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={active.enabled}
                      onChange={() => commit((d) => { const b = d[activeIndex]; if (b) b.enabled = !b.enabled; })}
                    />
                    启用此背景
                  </label>

                  {active.reason && (
                    <p className="rounded-md bg-muted/50 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
                      {active.reason}
                    </p>
                  )}

                  {active.bakedVisuals.length > 0 && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
                      <p className="text-[10px] font-medium text-amber-700 dark:text-amber-400">
                        保留（会写进补齐提示词）
                      </p>
                      <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                        {active.bakedVisuals.map((v, i) => (
                          <li key={i}>· {v}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    {(['x', 'y', 'width', 'height'] as const).map((field) => (
                      <label key={field} className="block space-y-1">
                        <span className="text-xs text-muted-foreground">
                          {field === 'width' ? '宽度' : field === 'height' ? '高度' : field.toUpperCase()}
                        </span>
                        <Input
                          type="number"
                          value={Math.round(active.bbox[field])}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (!Number.isFinite(v)) return;
                            commit((d) => {
                              const b = d[activeIndex];
                              if (b) b.bbox = normalizeSlicePlacement({ ...b.bbox, [field]: v }, naturalSize, MIN_SLICE_SIZE);
                            });
                          }}
                        />
                      </label>
                    ))}
                  </div>

                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      移除区域（{active.overlays.filter((o) => o.remove).length}/{active.overlays.length}）
                    </p>
                    <ul className="space-y-0.5">
                      {active.overlays.map((ov) => (
                        <li key={ov.id}>
                          <button
                            type="button"
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors',
                              selectedOverlayId === ov.id ? 'bg-primary/10' : 'hover:bg-muted',
                            )}
                            onClick={() => setSelectedOverlayId(ov.id)}
                          >
                            <input
                              type="checkbox"
                              checked={ov.remove}
                              onChange={() =>
                                commit((d) => {
                                  const o = d[activeIndex]?.overlays.find((x) => x.id === ov.id);
                                  if (o) o.remove = !o.remove;
                                })
                              }
                              onClick={(e) => e.stopPropagation()}
                            />
                            <span className="min-w-0 flex-1 truncate">{ov.name}</span>
                            <span className="shrink-0 rounded bg-muted px-1 text-[9px] text-muted-foreground">
                              {ov.kind === 'code-overlay' ? '代码层' : '位图层'}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </aside>
          </div>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {generating && progress
              ? `正在生成 ${progress.done + 1} / ${progress.total}…`
              : `将生成 ${enabledCount} 个完整背景，共移除 ${removeCount} 个区域`}
          </span>
          <div className="flex gap-2">
            {generating ? (
              <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                <X className="size-4" />
                取消
              </Button>
            ) : (
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
            )}
            <Button onClick={handleGenerate} disabled={generating || enabledCount === 0}>
              {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {generating ? '生成中…' : '生成完整背景'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 构造一个背景资产。 */
function makeBackgroundAsset(
  name: string,
  bbox: SlicePlacement,
  blobKey: string,
  bg: ReviewBackground,
  groupId: string,
  role: 'composite' | 'raw',
): SliceAsset {
  return {
    id: nanoid(),
    name,
    type: 'background',
    placement: { ...bbox },
    radius: 0,
    radii: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
    source: 'ai-background',
    reason: bg.reason,
    bakedVisuals: bg.bakedVisuals,
    aiVariantGroupId: groupId,
    aiVariantRole: role,
    // 背景是 AI 产物，锁定后移动不会触发重裁剪把它覆盖掉
    locked: true,
    transparent: false,
    aiTransparent: false,
    aiCompleted: true,
    hidden: false,
    originalBlobKey: blobKey,
    currentBlobKey: blobKey,
  };
}

/** 缩放手柄定位。 */
function handleStyle(h: ResizeHandle): React.CSSProperties {
  const map: Record<ResizeHandle, React.CSSProperties> = {
    nw: { left: 0, top: 0, transform: 'translate(-50%, -50%)' },
    n: { left: '50%', top: 0, transform: 'translate(-50%, -50%)' },
    ne: { right: 0, top: 0, transform: 'translate(50%, -50%)' },
    e: { right: 0, top: '50%', transform: 'translate(50%, -50%)' },
    se: { right: 0, bottom: 0, transform: 'translate(50%, 50%)' },
    s: { left: '50%', bottom: 0, transform: 'translate(-50%, 50%)' },
    sw: { left: 0, bottom: 0, transform: 'translate(-50%, 50%)' },
    w: { left: 0, top: '50%', transform: 'translate(-50%, -50%)' },
  };
  return map[h];
}
