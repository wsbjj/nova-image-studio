// 切图资产总览图（contact sheet）。
//
// 解决的问题：多轮对话下去，agent 只看得到 asset:<id> 这样的占位符，
// 根本不知道那张图长什么样，改着改着就把布局改得和素材对不上。
//
// 做法是把全部切图拼成一张带标签的大图，钉在每轮请求的固定前缀里。
// 为什么不每个切片发一张图：30 个切片各发一张大约 24K token 常驻；
// 拼成一张只要 1~2K，而模型照样能把 id 和具体图像对上号。
// 需要看某个切片的细节时，它在源截图里本来就按精确坐标存在。

import type { HydratedAsset } from '@/lib/slice-reconstruct';

const CELL_SIZE = 150;
const LABEL_HEIGHT = 24;
const PADDING = 8;
const MAX_COLUMNS = 5;

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}

/**
 * 把切图资产拼成一张总览图，返回 dataUrl。
 *
 * 资产为空、或环境不支持 canvas（如测试用的 jsdom）时返回 null，
 * 调用方据此退回「只挂源截图」——总览图是增强项，不该成为发不出请求的理由。
 */
export async function buildAssetContactSheet(
  assets: HydratedAsset[],
): Promise<string | null> {
  if (!assets.length) return null;

  try {
    const columns = Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(assets.length)));
    const rows = Math.ceil(assets.length / columns);
    const cellW = CELL_SIZE + PADDING * 2;
    const cellH = CELL_SIZE + LABEL_HEIGHT + PADDING * 2;

    const canvas = document.createElement('canvas');
    canvas.width = columns * cellW;
    canvas.height = rows * cellH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const images = await Promise.all(assets.map((asset) => loadImage(asset.dataUrl)));

    for (let i = 0; i < assets.length; i += 1) {
      const asset = assets[i];
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = col * cellW;
      const y = row * cellH;

      // 棋盘格底衬：切图多半带透明通道，纯白底上会看不出边界
      ctx.fillStyle = '#f1f3f5';
      ctx.fillRect(x + PADDING, y + PADDING, CELL_SIZE, CELL_SIZE);
      ctx.strokeStyle = '#dee2e6';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + PADDING + 0.5, y + PADDING + 0.5, CELL_SIZE - 1, CELL_SIZE - 1);

      const image = images[i];
      if (image && image.naturalWidth > 0 && image.naturalHeight > 0) {
        const scale = Math.min(
          CELL_SIZE / image.naturalWidth,
          CELL_SIZE / image.naturalHeight,
          1,
        );
        const drawW = Math.max(1, image.naturalWidth * scale);
        const drawH = Math.max(1, image.naturalHeight * scale);
        ctx.drawImage(
          image,
          x + PADDING + (CELL_SIZE - drawW) / 2,
          y + PADDING + (CELL_SIZE - drawH) / 2,
          drawW,
          drawH,
        );
      }

      // 标签写 id 而不只是名字：模型在 HTML 里要引用的是 asset:<id>
      ctx.fillStyle = '#212529';
      ctx.font = '11px -apple-system, "Segoe UI", "PingFang SC", sans-serif';
      ctx.textBaseline = 'top';
      const labelY = y + PADDING + CELL_SIZE + 4;
      ctx.fillText(truncate(ctx, asset.id, CELL_SIZE), x + PADDING, labelY);
      ctx.fillStyle = '#868e96';
      ctx.fillText(truncate(ctx, asset.name || '', CELL_SIZE), x + PADDING, labelY + 12);
    }

    return canvas.toDataURL('image/webp', 0.85);
  } catch {
    return null;
  }
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  let value = String(text || '');
  if (ctx.measureText(value).width <= maxWidth) return value;
  while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}…`;
}
