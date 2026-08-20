'use client';

import { useEffect, useRef, useState } from 'react';
import { Eraser, Loader2, Paintbrush, Sparkles, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';
import { getBlob, putBlob } from '@/lib/slice-db';
import { runSliceInpaintWithMask } from '@/lib/slice-inpaint';
import { hasSliceImageModel } from '@/lib/slice-model-config';
import type { SliceAsset } from '@/lib/slice-types';

import { canvasToBlob, loadImageElement } from './slice-canvas-utils';

interface SliceInpaintEditorProps {
  asset: SliceAsset | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** registry 条目 id（Tab 内图片模型选择器记住的那个），留空则回退到设置里的默认项 */
  model: string;
  onSaved: (assetId: string, newBlobKey: string) => void;
  onConfigureApiKey: () => void;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
}

/**
 * AI 补齐编辑器：双层 Canvas（底图 + 蒙版），手绘蒙版后调用 AI 重建被遮挡区域。
 * - 画笔（白色） / 橡皮（destination-out 透明） / 粗细滑块
 * - 蒙版 Canvas 透明背景 + 白色笔触；提交时合成黑底白笔的完整蒙版
 * - 支持取消进行中的请求（AbortController）
 */
export function SliceInpaintEditor({
  asset,
  open,
  onOpenChange,
  model,
  onSaved,
  onConfigureApiKey,
  showToast,
}: SliceInpaintEditorProps) {
  const imageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultBlobRef = useRef<Blob | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const drawingRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const [tool, setTool] = useState<'brush' | 'eraser'>('brush');
  const [brushSize, setBrushSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** 双结果：局部合成（蒙版外逐位保留原图）与 AI 原图（模型完整输出） */
  const [variant, setVariant] = useState<'composite' | 'raw'>('composite');
  const variantsRef = useRef<{ composite: Blob; raw: Blob } | null>(null);
  const [displaySize, setDisplaySize] = useState<{ w: number; h: number } | null>(null);
  /**
   * 已解码的底图。刻意作为 state 而不是在加载 effect 里直接画进 canvas：
   * 加载 effect 跑在 loading === true 期间，此时渲染走的是「图片加载中…」分支，
   * 两个 <canvas> 还没挂载、ref 都是 null，直接画会静默失败且 effect 不会重跑，
   * 结果就是参考图永远不显示。交给下面依赖 displaySize 的 effect 去画。
   */
  const [decoded, setDecoded] = useState<HTMLImageElement | null>(null);
  const [prevResetKey, setPrevResetKey] = useState<string | null>(null);

  // open 或 asset 变化时重置状态（渲染期间调整状态，避免 effect 体内同步 setState）。
  const resetKey = open && asset ? `${asset.id}` : null;
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    if (resetKey) {
      setLoading(true);
      setPreviewUrl(null);
      // 不清掉上一张的话，切换切图时会先闪一帧旧图
      setDecoded(null);
      setDisplaySize(null);
    }
  }

  // 取 blob → 解码 → 算显示尺寸。只负责拿到图，不碰 canvas。
  useEffect(() => {
    if (!open || !asset) return;
    let active = true;
    resultBlobRef.current = null;

    void (async () => {
      try {
        const blob = await getBlob(asset.currentBlobKey);
        if (!blob || !active) return;
        const img = await loadImageElement(blob);
        if (!active) return;
        // 按视口高度 55% 计算显示尺寸，保持比例，不超过原始尺寸
        const maxH = typeof window !== 'undefined' ? window.innerHeight * 0.55 : 400;
        const scale = Math.min(maxH / img.naturalHeight, 1);
        setDisplaySize({
          w: Math.round(img.naturalWidth * scale),
          h: Math.round(img.naturalHeight * scale),
        });
        setDecoded(img);
      } catch (err) {
        showToast(err instanceof Error ? err.message : '图片加载失败', 'error');
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [open, asset, showToast]);

  /**
   * 底图与蒙版层的初始化。
   * 依赖 decoded + displaySize：两者就绪意味着 loading 已置 false、渲染已走到 canvas 分支，
   * 此时 ref 必然可用。这是修「参考图不显示」的关键 —— 画的时机必须晚于挂载。
   */
  useEffect(() => {
    if (!decoded || !displaySize) return;
    const imageCanvas = imageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!imageCanvas || !maskCanvas) return;

    const w = decoded.naturalWidth;
    const h = decoded.naturalHeight;
    imageCanvas.width = w;
    imageCanvas.height = h;
    maskCanvas.width = w;
    maskCanvas.height = h;
    const ictx = imageCanvas.getContext('2d');
    const mctx = maskCanvas.getContext('2d');
    if (!ictx || !mctx) return;
    ictx.clearRect(0, 0, w, h);
    ictx.drawImage(decoded, 0, 0);
    mctx.clearRect(0, 0, w, h);
  }, [decoded, displaySize]);

  // 卸载时清理预览 objectURL 与进行中的请求
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const getCanvasPos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, rect.width);
    const scaleY = canvas.height / Math.max(1, rect.height);
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const configureCtx = (ctx: CanvasRenderingContext2D) => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize;
    if (tool === 'brush') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#ffffff';
      ctx.fillStyle = '#ffffff';
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
    }
  };

  const drawDot = (pos: { x: number; y: number }) => {
    const ctx = maskCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    configureCtx(ctx);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const drawLine = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = maskCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    configureCtx(ctx);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    drawingRef.current = true;
    const pos = getCanvasPos(e);
    lastPosRef.current = pos;
    drawDot(pos);
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const pos = getCanvasPos(e);
    const last = lastPosRef.current;
    if (last) drawLine(last, pos);
    lastPosRef.current = pos;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = false;
    lastPosRef.current = null;
    try {
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const handleGenerate = async () => {
    if (!asset) return;
    if (!hasSliceImageModel()) {
      showToast('AI 补齐需要一个 OpenAI 协议的图片模型，请先在设置中添加', 'error');
      onConfigureApiKey();
      return;
    }
    const imageCanvas = imageCanvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    if (!imageCanvas || !maskCanvas) return;

    setGenerating(true);
    try {
      const imageBlob = await canvasToBlob(imageCanvas, 'image/png');

      // 合成完整蒙版：黑底 + 白色笔触
      const maskTemp = document.createElement('canvas');
      maskTemp.width = maskCanvas.width;
      maskTemp.height = maskCanvas.height;
      const mctx = maskTemp.getContext('2d');
      if (!mctx) throw new Error('Canvas 2D 上下文不可用');
      mctx.fillStyle = '#000';
      mctx.fillRect(0, 0, maskTemp.width, maskTemp.height);
      mctx.drawImage(maskCanvas, 0, 0);
      const maskBlob = await canvasToBlob(maskTemp, 'image/png');

      const controller = new AbortController();
      abortRef.current = controller;

      // 走完整管线：letterbox 尺寸对齐往返 + 按笔触蒙版羽化合成。
      // 直接把模型输出当结果会拉伸错位并整体色偏（移植版就是这么做的）。
      const { composite, raw } = await runSliceInpaintWithMask({
        model,
        baseBlob: imageBlob,
        maskBlob,
        width: imageCanvas.width,
        height: imageCanvas.height,
        assetName: asset.name,
        signal: controller.signal,
      });

      variantsRef.current = { composite, raw };
      setVariant('composite');
      resultBlobRef.current = composite;
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      const url = URL.createObjectURL(composite);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      showToast('AI 补齐完成，可切换「局部合成 / AI 原图」后保存', 'success');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        showToast('已取消 AI 补齐', 'info');
      } else {
        showToast(err instanceof Error ? err.message : 'AI 补齐失败', 'error');
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  const handleCancelRequest = () => {
    abortRef.current?.abort();
  };

  /** 在局部合成与 AI 原图之间切换预览，同时切换将要保存的 Blob。 */
  const switchVariant = (next: 'composite' | 'raw') => {
    const variants = variantsRef.current;
    if (!variants || next === variant) return;
    const blob = next === 'composite' ? variants.composite : variants.raw;
    resultBlobRef.current = blob;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(blob);
    previewUrlRef.current = url;
    setPreviewUrl(url);
    setVariant(next);
  };

  const handleSave = async () => {
    if (!asset || !resultBlobRef.current) return;
    try {
      const key = await putBlob(resultBlobRef.current, 'image/png');
      if (!key) {
        showToast('保存失败', 'error');
        return;
      }
      onSaved(asset.id, key);
      showToast('已保存到切图', 'success');
      onOpenChange(false);
    } catch {
      showToast('保存失败', 'error');
    }
  };

  const handleClose = (next: boolean) => {
    if (generating) return; // 生成中不允许关闭
    if (!next) {
      abortRef.current?.abort();
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
        previewUrlRef.current = null;
        setPreviewUrl(null);
        resultBlobRef.current = null;
      }
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI 补齐编辑器</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
            <Button size="xs" variant={tool === 'brush' ? 'default' : 'ghost'} onClick={() => setTool('brush')}>
              <Paintbrush className="size-3.5" />
              画笔
            </Button>
            <Button size="xs" variant={tool === 'eraser' ? 'default' : 'ghost'} onClick={() => setTool('eraser')}>
              <Eraser className="size-3.5" />
              橡皮
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">粗细</span>
            <Slider
              value={[brushSize]}
              min={5}
              max={50}
              step={1}
              onValueChange={(v) => setBrushSize(v[0] ?? 20)}
              className="w-32"
            />
            <span className="w-8 text-xs tabular-nums">{brushSize}</span>
          </div>
          <Button onClick={handleGenerate} disabled={generating || loading} size="sm">
            {generating ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {generating ? '补齐中…' : 'AI 补齐'}
          </Button>
          {generating && (
            <Button onClick={handleCancelRequest} variant="outline" size="sm">
              <X className="size-4" />
              取消请求
            </Button>
          )}
        </div>

        <div className="grid max-h-[62vh] place-items-center overflow-auto rounded-lg border border-border bg-muted/30 p-2">
          {loading ? (
            <div className="py-12 text-sm text-muted-foreground">图片加载中…</div>
          ) : previewUrl ? (
            <div className="space-y-2">
              <img src={previewUrl} alt="补齐预览" className="max-h-[55vh] max-w-full object-contain" />
              {/* 双结果二选一：不替用户决定哪个更好 */}
              <div className="flex items-center justify-center gap-1">
                {(
                  [
                    { key: 'composite' as const, label: '局部合成', hint: '只替换蒙版内像素，蒙版外与原图完全一致' },
                    { key: 'raw' as const, label: 'AI 原图', hint: '模型完整输出，更自然但可能整体色偏' },
                  ]
                ).map((option) => (
                  <Button
                    key={option.key}
                    size="sm"
                    variant={variant === option.key ? 'secondary' : 'ghost'}
                    title={option.hint}
                    onClick={() => switchVariant(option.key)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <p className="text-center text-xs text-muted-foreground">
                {variant === 'composite'
                  ? '局部合成：蒙版外像素与原图逐位相同'
                  : 'AI 原图：模型完整输出'}
                　确认后点击「保存到切图」
              </p>
            </div>
          ) : displaySize ? (
            <div className="relative leading-none" style={{ width: displaySize.w, height: displaySize.h }}>
              <canvas
                ref={imageCanvasRef}
                className="block"
                style={{ width: displaySize.w, height: displaySize.h }}
              />
              <canvas
                ref={maskCanvasRef}
                className="absolute left-0 top-0"
                style={{
                  width: displaySize.w,
                  height: displaySize.h,
                  touchAction: 'none',
                  cursor: 'crosshair',
                  opacity: 0.55,
                }}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
              />
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            不保存
          </Button>
          <Button onClick={handleSave} disabled={!previewUrl || generating}>
            保存到切图
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
