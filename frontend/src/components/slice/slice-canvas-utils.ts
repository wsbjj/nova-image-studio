// 切图编辑器的 Canvas 工具函数：裁剪源图、转 dataURL、生成蒙版等。
// 供 SliceEditor、BackgroundConfirmDialog、SliceInpaintEditor 共用。
// 裁剪与圆角渲染的权威实现在 lib/slice-crop.ts（含版本守卫），此处只保留编辑器专用的辅助函数。

import { canvasToBlob, renderSliceBlob } from '@/lib/slice-crop';
import type { SlicePlacement } from '@/lib/slice-types';

export { canvasToBlob };

/** 将 HTMLImageElement 绘制到 canvas 并转为 dataURL（image/png）。 */
export function imageElementToDataUrl(img: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 上下文不可用');
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** 从源图裁剪指定区域，返回 PNG Blob（不含圆角；需要圆角请直接用 renderSliceBlob）。 */
export function cropImageBlob(img: HTMLImageElement, bbox: SlicePlacement): Promise<Blob> {
  return renderSliceBlob(img, bbox, null);
}

/**
 * 生成 AI 补齐蒙版：黑色背景，指定区域填充白色。
 * 蒙版尺寸与裁剪图一致，白色区域表示需要重建的覆盖层。
 */
export function createInpaintMaskBlob(
  width: number,
  height: number,
  regions: Array<{ x: number; y: number; width: number; height: number }>,
): Promise<Blob> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Canvas 2D 上下文不可用'));
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  for (const r of regions) {
    ctx.fillRect(
      Math.round(r.x),
      Math.round(r.y),
      Math.max(1, Math.round(r.width)),
      Math.max(1, Math.round(r.height)),
    );
  }
  return canvasToBlob(canvas, 'image/png');
}

/** 从 Blob 加载为 HTMLImageElement（用于绘制到 canvas）。加载完成后立即 revoke objectURL。 */
export function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // 图片已解码到内存，revoke objectURL 不影响后续 drawImage
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片加载失败'));
    };
    img.src = url;
  });
}
