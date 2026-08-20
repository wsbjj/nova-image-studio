// 切图矢量化：本地算法追踪（imagetracerjs）+ AI 返回 SVG 的校验与规范化。
//
// 对应上游 imagetoslice 的两条路径：
//   算法：app.js rasterAssetToEditableSvg() —— 上游优先打后端 VTracer，失败回退 ImageTracerJS。
//         本项目前端直连模型、没有自建切图后端，因此只保留 ImageTracerJS 这一档。
//   AI：  server.js sanitizeGeneratedSvg() + ui/services/svg-utils.js normalizeVectorSvg()。
//
// 校验器不可省：模型很容易吐出「内嵌 base64 位图的假 SVG」——看着像矢量，
// 实际是 <image> 包了一张 PNG，导入 Figma 或再次编辑时完全不可用。

import tracer from 'imagetracerjs';

/** 追踪采样的长边上限。原图直接追踪会产生上万条路径，先降采样再按比例放大坐标。 */
const MAX_SAMPLE_SIZE = 420;

/** 本地追踪的路径数上限。超过说明这素材细节太碎，矢量化没有收益。 */
const MAX_LOCAL_PATHS = 700;

/** AI 返回 SVG 的可编辑图形数上限。上游同为 220。 */
const MAX_AI_SHAPES = 220;

/** 可编辑图形元素白名单，用于计数校验。 */
const SHAPE_TAG_PATTERN = /<(path|rect|circle|ellipse|line|polyline|polygon)\b/gi;

/**
 * 模型 SVG 的禁止内容。
 * <image> 与 href/data: 是重点：它们能让「SVG」实际只是位图容器。
 */
const BLOCKED_SVG_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /<script\b/i, reason: '包含 script' },
  { pattern: /<foreignObject\b/i, reason: '包含 foreignObject' },
  { pattern: /<image\b/i, reason: '内嵌了位图而不是矢量路径' },
  { pattern: /\bon[a-z]+\s*=/i, reason: '包含事件处理属性' },
  { pattern: /\b(?:href|xlink:href)\s*=/i, reason: '引用了外部资源' },
  { pattern: /data:image\//i, reason: '内嵌了 base64 位图' },
  { pattern: /javascript:/i, reason: '包含 javascript: 协议' },
];

/** SVG 校验失败。与网络/额度错误区分开，便于调用方决定是否重试。 */
export class SvgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgValidationError';
  }
}

/** 统计可编辑图形元素数量。 */
export function countSvgShapes(svg: string): number {
  return (svg.match(SHAPE_TAG_PATTERN) || []).length;
}

/**
 * 强制改写根标签的尺寸与 viewBox，对齐切图的像素尺寸。
 * 模型经常自作主张给 24x24 或干脆省略，导致贴回画布时比例错乱。
 */
export function normalizeVectorSvg(svg: string, width: number, height: number): string {
  const openTagMatch = svg.match(/<svg\b[^>]*>/i);
  if (!openTagMatch) throw new SvgValidationError('SVG 缺少根标签');
  const openTag = openTagMatch[0];
  const normalized = openTag
    .replace(/\s(?:width|height|viewBox)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/<svg/i, `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`);
  return svg.replace(openTag, normalized);
}

/**
 * 校验并提取模型返回的 SVG。
 * @throws SvgValidationError 任一项不合格
 */
export function sanitizeGeneratedSvg(text: string): string {
  const withoutFence = String(text || '')
    .replace(/^\s*```(?:svg|xml|html)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const match = withoutFence.match(/<svg\b[\s\S]*?<\/svg>/i);
  if (!match) throw new SvgValidationError('模型没有返回有效 SVG');
  const svg = match[0].trim();

  const blocked = BLOCKED_SVG_PATTERNS.find((entry) => entry.pattern.test(svg));
  if (blocked) throw new SvgValidationError(`模型返回的 SVG ${blocked.reason}`);

  const openTag = svg.match(/<svg\b[^>]*>/i)?.[0] || '';
  if (!/\bviewBox\s*=/i.test(openTag)) {
    throw new SvgValidationError('模型返回的 SVG 缺少 viewBox');
  }

  const shapeCount = countSvgShapes(svg);
  if (shapeCount === 0) throw new SvgValidationError('模型返回的 SVG 没有可编辑图形元素');
  if (shapeCount > MAX_AI_SHAPES) {
    throw new SvgValidationError(`AI SVG 图层过多（${shapeCount}），请重新切更小的区域或简化素材`);
  }

  return svg;
}

/** SVG 源码 → data URL，供 <img> 预览。 */
export function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 本地算法矢量化：位图 → 可编辑 SVG。
 * 不消耗 AI 额度，因此支持批量执行。
 *
 * @param source 已解码的位图
 * @param targetWidth 输出 SVG 的宽（通常是 placement.width）
 * @param targetHeight 输出 SVG 的高
 */
export async function vectorizeToSvg(
  source: HTMLImageElement | HTMLCanvasElement,
  targetWidth: number,
  targetHeight: number,
): Promise<string> {
  const sourceWidth =
    source instanceof HTMLImageElement ? source.naturalWidth || source.width : source.width;
  const sourceHeight =
    source instanceof HTMLImageElement ? source.naturalHeight || source.height : source.height;
  if (!sourceWidth || !sourceHeight) throw new SvgValidationError('切图尺寸无效，无法矢量化');

  const width = Math.max(1, Math.round(targetWidth || sourceWidth));
  const height = Math.max(1, Math.round(targetHeight || sourceHeight));

  // 降采样后追踪，再用 scale 把坐标放大回目标尺寸
  const scale = Math.min(1, MAX_SAMPLE_SIZE / Math.max(sourceWidth, sourceHeight));
  const sampleWidth = Math.max(1, Math.round(sourceWidth * scale));
  const sampleHeight = Math.max(1, Math.round(sourceHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new SvgValidationError('Canvas 2D 上下文不可用');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, sampleWidth, sampleHeight);

  const imageData = ctx.getImageData(0, 0, sampleWidth, sampleHeight);

  // 参数与上游 app.js:5214 一致，是针对 UI 图标调过的一组值
  const svg = tracer.imagedataToSVG(imageData, {
    ltres: 0.5,
    qtres: 0.5,
    pathomit: 8,
    rightangleenhance: false,
    colorsampling: 2,
    numberofcolors: 18,
    mincolorratio: 0.01,
    colorquantcycles: 3,
    layering: 0,
    strokewidth: 0,
    linefilter: true,
    scale: width / sampleWidth,
    roundcoords: 1,
    viewbox: false,
    desc: false,
    blurradius: 0,
    blurdelta: 20,
  });

  const pathCount = (svg.match(/<path/g) || []).length;
  if (pathCount === 0) throw new SvgValidationError('没有检测到可转换的 SVG 路径');
  if (pathCount > MAX_LOCAL_PATHS) {
    throw new SvgValidationError(`路径过多（${pathCount}），这个素材更适合保留 PNG`);
  }

  return normalizeVectorSvg(svg, width, height);
}
