// AI 图层导入 / H5 重建
// 将源图截图 + 切图资产描述发送给视觉模型，生成可编辑的 HTML/CSS 预览。
// 移植自 imagetoslice 子项目的 fast-editable-html.js + fast-html-sanitizer.js + server.js prompt 构建。
// 原版通过本地后端 API 调用模型；本版经 /api/nova/proxy/text 转发（与 slice-ai-client.ts 同路径）。

import {
  buildNovaAgentRequestBody,
  getNovaAgentIncompleteReason,
  postNovaProxyText,
  supportsReasoningSummary,
  type NovaAgentUsage,
} from '@/lib/nova-agent-protocol';
import { readNovaAgentStream, type NovaAgentPhase } from '@/lib/nova-agent-stream';
import { requireSliceTextModel } from '@/lib/slice-model-config';
import { getBlob } from '@/lib/slice-db';
import { getSliceRadii } from '@/lib/slice-geometry';
import type { SliceWorkspaceDraft } from '@/lib/slice-types';
import type { ReplicaFilePath, ReplicaFiles } from '@/lib/web-agent/vfs';
import { downloadBlob } from '@/lib/backup-utils';
import { zipSync, strToU8 } from 'fflate';

// ===== 类型 =====

/** 发给模型的切图资产描述（仅元数据，不含图片数据） */
interface ReferenceAssetDescriptor {
  id: string;
  name: string;
  kind: string;
  radius: number;
  placement: { x: number; y: number; width: number; height: number };
}

/** 预览用的切图资产（含 dataUrl） */
export interface HydratedAsset {
  id: string;
  name: string;
  dataUrl: string;
  placement: { x: number; y: number; width: number; height: number };
  radius: number;
}

/** H5 重建的输出 token 预算 */
const RECONSTRUCT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * 首次复刻的思考强度。
 * 开源版 registry 没有「思考等级」这一维，固定为 high —— 一次要产出三份完整文件，
 * 降档最先牺牲的就是布局精度。实际取值由 buildNovaAgentRequestBody 按协议折算。
 */
const RECONSTRUCT_REASONING_EFFORT = 'high';

// ===== 1. 收集切图资产描述 =====

/**
 * 从工作区收集可见切图资产的元数据描述。
 * 模型只需要坐标、名称、类型和圆角，不需要图片二进制数据。
 *
 * 重复 id 直接抛错而不是静默去重：`asset:<id>` 是模型与资产之间唯一的锚点，
 * id 撞车会让注入阶段随机挑一张图，产出的网页看起来「就是配错了图」，极难排查。
 */
export function collectReferenceAssetDescriptors(
  workspace: SliceWorkspaceDraft,
): ReferenceAssetDescriptor[] {
  const seen = new Set<string>();
  return workspace.assets
    .filter((a) => !a.hidden)
    .map((a) => {
      const id = String(a.id || '').trim();
      if (!id) throw new Error(`切图「${a.name || '未命名'}」缺少 id，无法生成网页复刻`);
      if (seen.has(id)) throw new Error(`切图 id 重复：${id}，无法生成网页复刻`);
      seen.add(id);
      const radii = getSliceRadii(a, workspace.screen);
      return {
        id,
        name: a.name || id,
        kind: a.type,
        radius: Math.max(radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft),
        placement: { ...a.placement },
      };
    });
}

/** 从 HTML 中提取被实际引用的 asset id 集合。 */
export function collectReferencedAssetIds(html: string): Set<string> {
  const ids = new Set<string>();
  const source = String(html || '');
  // 两种写法都算引用：src="asset:<id>" 与 data-reference-asset="<id>"
  for (const match of source.matchAll(/src=(["'])asset:(.*?)\1/gi)) {
    if (match[2]) ids.add(match[2]);
  }
  for (const match of source.matchAll(/\bdata-reference-asset=(["'])(.*?)\1/gi)) {
    if (match[2]) ids.add(match[2]);
  }
  return ids;
}

/**
 * 找出 HTML 引用了、但资产列表里并不存在的 id。
 * 模型偶尔会编造 `asset:hero_image` 这类不存在的引用，
 * 不检出的话导出后就是一个坏掉的 <img>，用户只看到裂图。
 */
export function findUnresolvedAssetIds(html: string, assets: Array<{ id: string }>): string[] {
  const known = new Set(assets.map((a) => a.id));
  return Array.from(collectReferencedAssetIds(html)).filter((id) => !known.has(id));
}

/**
 * 收集可见切图资产的 dataUrl（用于预览注入和导出）。
 */
export async function collectHydratedAssets(
  workspace: SliceWorkspaceDraft,
): Promise<HydratedAsset[]> {
  const result: HydratedAsset[] = [];
  for (const asset of workspace.assets.filter((a) => !a.hidden)) {
    const blob = await getBlob(asset.currentBlobKey);
    if (!blob) continue;
    const dataUrl = await blobToDataUrl(blob);
    const radii = getSliceRadii(asset, workspace.screen);
    result.push({
      id: asset.id,
      name: asset.name || asset.id,
      dataUrl,
      placement: { ...asset.placement },
      radius: Math.max(radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft),
    });
  }
  return result;
}

// ===== 2. 构建 prompt =====

/**
 * 构建发给视觉模型的 H5 重建提示词。
 * 移植自 imagetoslice/server.js 的 buildEditableDesignH5Prompt。
 *
 * multiFile = true 时产出 index.html / styles.css / script.js 三个文件。
 * 像素保真与切图锚点规则两种模式完全共用——差异只在「代码放哪、怎么输出」，
 * 所以这里用参数分支而不是复制一份九十行的规则文本。
 */
function buildEditableDesignH5Prompt(params: {
  prompt: string;
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  referenceAssets: ReferenceAssetDescriptor[];
  multiFile?: boolean;
}): string {
  const { prompt, width, height, previewWidth, previewHeight, referenceAssets } = params;
  const multiFile = params.multiFile === true;
  const assetLines = referenceAssets.length
    ? referenceAssets
        .map((asset, index) => {
          const p = asset.placement;
          const sx = Math.round(p.x * (previewWidth / width));
          const sy = Math.round(p.y * (previewHeight / height));
          const sw = Math.round(p.width * (previewWidth / width));
          const sh = Math.round(p.height * (previewHeight / height));
          const radius = Math.round((asset.radius || 0) * (previewWidth / width));
          return `- asset ${index + 1}: id=${asset.id}, name=${asset.name}, metadata only, source x=${p.x}, y=${p.y}, w=${p.width}, h=${p.height}, radius=${asset.radius || 0}; preview x=${sx}, y=${sy}, w=${sw}, h=${sh}, radius=${radius}. REQUIRED ANCHOR HTML: <img class="readable-name" data-reference-asset="${asset.id}" src="asset:${asset.id}" alt="${asset.name || asset.id}">. Put its geometry in class-based CSS. Do not redraw, replace, simplify, recolor, crop, or move it.`;
        })
        .join('\n')
    : '- No user-sliced assets were provided.';

  return [
    'You are a senior UI screenshot-to-HTML reconstruction engineer and mobile UI tracing specialist.',
    'Convert the attached UI screenshot into one standalone HTML document for visual inspection and later Figma import.',
    'Return human-readable production-style HTML that a frontend developer can continue editing.',
    'Choose tags and nesting from the screenshot content. Do not force a fixed semantic tag checklist.',
    'Group each coherent visual unit so its image, title, description, badge, and action live under one readable parent.',
    'Repeated units must use a consistent DOM shape and readable reusable class names.',
    'This is a pixel-reconstruction task. The goal is not a nicer similar app, but a faithful HTML trace of the provided screenshot.',
    'Think of this as manually tracing the screenshot on an artboard that matches the source image width, not redesigning an app screen.',
    '',
    'Highest priority:',
    `- The output artboard width MUST be exactly ${previewWidth}px.`,
    `- The output artboard height MUST be exactly ${previewHeight}px, derived from the original screenshot ${width}x${height}.`,
    '- Reconstruct the screenshot, do not redesign it, do not improve it, do not simplify it, and do not create a new visual style.',
    '- Preserve relative position, proportion, visual hierarchy, colors, gradients, shadows, border radii, strokes, spacing, typography, and layer order.',
    '- Use .fit-shell > .fit-box > .screen as the stable outer structure.',
    '- Keep .screen at the exact source width and height. Use parent-local coordinates inside each visual component.',
    '- Major visual geometry remains fixed and pixel-accurate; semantic nesting must not trigger responsive reflow.',
    '- Use the screenshot as the coordinate source: status bar, header, cards, icons, tabs, list rows, and bottom navigation must keep their original x/y/width/height relationships.',
    '- The screenshot is the only source of truth. The user prompt is only theme context and must not be copied as interface text.',
    '- Do not use the full screenshot as a background image. Build the UI with HTML/CSS shapes, editable text, and provided sliced assets.',
    '- Every provided sliced asset is mandatory and is a locked visual anchor. Place each one as an <img> inside .screen at its exact preview x/y/width/height.',
    '- If a sliced asset is an icon, mascot, avatar, decorative badge, product image, or complex graphic, DO NOT redraw it with CSS/SVG and DO NOT replace it with a similar icon. Use the exact asset:<id> image.',
    '- The injected asset must be visible in the final page. Do not cover it with white cards, text blocks, masks, or gradients.',
    '- Put sliced assets above their matching card/background but below only text that truly overlays the original image. Do not hide them behind white cards.',
    '- Do not invent large blank cards. If a region exists, fill it with its visible content.',
    '- Transcribe all visible text from the screenshot, even when it partially or fully overlaps a sliced asset. If unreadable, use a very short plausible placeholder only where text exists.',
    '- Text must not reflow differently from the screenshot. Short labels, currency values, dates, tab labels, button labels, nav labels, and list titles should use white-space:nowrap.',
    '- Multi-line text is allowed only when the screenshot itself clearly shows multiple lines.',
    '- Currency and numeric values must stay on one line, e.g. ¥268.00 must not become two lines or lose decimals.',
    '- Do not replace real icons with empty squares, checkboxes, emoji, generic placeholders, or unrelated icon glyphs.',
    '- If an icon is not provided as a sliced asset, draw a simple inline SVG with matching size, stroke weight, and position.',
    '- Never use literal arrow characters such as ›, ‹, →, ←, ↓, ↑, >, or < as UI arrows. Draw chevrons, back arrows, refresh arrows, and dropdown arrows as inline SVG shapes so they remain vector icons after Figma import.',
    '- Avoid oversized text. Match the screenshot\'s apparent font scale in the source image: header text, card labels, secondary text, badges, and navigation labels must stay visually proportional to the screenshot.',
    ...(multiFile
      ? [
          '- All layout and presentation must be class-based CSS placed in styles.css. Do not use inline style attributes and do not put a <style> block in index.html.',
          '- No external URLs. No web fonts. No network requests.',
          '- JavaScript goes in script.js only, and is limited to local DOM interaction that the screenshot implies (tab switching, accordion, carousel dots). No fetch, no XMLHttpRequest, no timers that mutate layout geometry.',
        ]
      : [
          '- All layout and presentation must be class-based CSS in <style>. Do not use inline style attributes.',
          '- No JavaScript. No external URLs. No web fonts.',
        ]),
    '- Use CSS gradients and shadows where the screenshot has them.',
    '- For complex avatars, colorful icons, mascot IP, product photos, decorative illustrations, and all user-sliced assets, use <img> layers.',
    '- For generic simple line icons not provided as slices, draw only very simple monochrome inline SVG paths or CSS strokes. Do not create colorful decorative SVG icons, do not redesign icons, and do not use emoji as icons.',
    '- Do not output any <img> tag unless it is one of the provided asset:<id> references. For unsliced simple icons, use inline <svg>.',
    '- Reference asset elements and their positioned ancestors must not use transform, rotate, skew, or scale.',
    '- Do not invent real URLs, API calls, application state, or complex JavaScript interactions.',
    '',
    'Absolute-positioning implementation rules:',
    '- .screen must be position:relative; each major visual region should have explicit geometry.',
    '- Use nested positioned containers for coherent cards, banners, list rows, navigation groups, and repeated components.',
    '- Inside each component, use parent-local left/top coordinates or stable flex/grid layout when it preserves the screenshot exactly.',
    '- For every text and SVG element, set explicit geometry, typography, and white-space where appropriate.',
    '- Do not let line-height, margins, padding, flex wrapping, or browser defaults change the screenshot geometry.',
    '- Reset h1,h2,h3,p,button margins to 0 in CSS.',
    '',
    'Provided sliced assets:',
    assetLines,
    '',
    'Reference-asset usage rules:',
    '- Treat every listed asset as an already-cut real UI element. Its coordinates are authoritative.',
    '- A sliced asset rectangle only defines that image asset\'s geometry. Do not use overlap with it as evidence that nearby or overlapping text, icons, badges, decoration, or controls should be omitted.',
    '- Place each reference asset inside its smallest coherent component owner: the item, row, card, entry, or action that owns its related text.',
    '- Use parent-local left/top coordinates for a nested reference asset while preserving its authoritative screen-relative rectangle.',
    '- Do not place all reference assets directly under .screen merely to keep global coordinates.',
    '- Page-wide artwork, section-wide decoration, and assets with no reliable component owner may remain at a broad container.',
    '- Create surrounding text, card backgrounds, dividers, buttons, and labels around these assets, but do not synthesize replacement artwork for them.',
    '- If an asset belongs to a grid item or card, reconstruct the whole grid/card around the fixed asset coordinate.',
    '- If an asset overlaps a section that the model thinks is blank, the asset wins: keep the asset and reconstruct the nearby UI.',
    '',
    'Pixel reconstruction workflow:',
    '1. Read the screenshot directly and create the main screen background and section bounding boxes first.',
    '2. Place all cards, banners, list rows, nav bars, search boxes, buttons, dividers, and gradients at their approximate screenshot coordinates.',
    '3. Place all required <img data-reference-asset> anchors at the exact coordinates listed above.',
    '4. Add visible text from the screenshot, preserving line breaks, font weight, size hierarchy, and color.',
    '5. Add simple unsliced line icons only where the screenshot has unsliced line icons.',
    '6. Review for common failures: no empty giant cards, no copied user prompt as UI text, no missing sliced assets, no rearranged grid, no unrelated icon set.',
    '',
    'HTML requirements:',
    ...(multiFile
      ? [
          '- Output exactly three files: index.html, styles.css, script.js. Emit them in that order using the delimiter format described below.',
          '- index.html must contain <!doctype html>, <html>, <head>, <meta charset="UTF-8">, a meaningful <title> inferred from the visible page, and <body>.',
          '- index.html must link the other two files exactly like this: <link rel="stylesheet" href="./styles.css"> in <head>, and <script src="./script.js" defer></script> before </body>.',
          '- styles.css contains every rule. index.html must contain no <style> block and no style="" attribute.',
          '- script.js must always be emitted even when the screenshot implies no interaction; in that case a single short comment line is enough. Never omit the file.',
        ]
      : [
          '- Return only the complete HTML document, no Markdown fences and no explanation.',
          '- The document must contain <!doctype html>, <html>, <head>, <meta charset="UTF-8">, <style>, and <body>.',
          '- The document must contain a meaningful <title> inferred from the visible page.',
        ]),
    '- Body background may be neutral gray for preview only; the UI itself must be inside .screen.',
    '- .screen must have width and height exactly as specified and overflow hidden.',
    '- Asset references must use src="asset:<id>". Do not embed base64 yourself.',
    '- Asset references should include data-reference-asset="<id>" so the importer can preserve them.',
    '- Keep CSS readable and grouped by major regions.',
    '- Prefer border-box sizing.',
    '',
    'ScreenCoder-style reasoning checklist to apply silently before writing HTML:',
    '1. Identify all UI regions from top to bottom.',
    '2. Estimate the bounding box of every card/list/grid/nav/header/banner.',
    '3. Transcribe visible text and place it at matching coordinates.',
    '4. Reuse every provided sliced asset in its exact position. Treat these assets as locked visual anchors.',
    '5. Recreate gradients/backgrounds before placing foreground content.',
    '6. Compare mentally against screenshot and adjust obvious spacing/size issues.',
    '',
    ...(multiFile
      ? [
          'Output format — emit the three files exactly like this, with no Markdown fences and no commentary:',
          '===== FILE: index.html =====',
          '<!doctype html>',
          '...',
          '===== FILE: styles.css =====',
          '...',
          '===== FILE: script.js =====',
          '...',
          '===== END =====',
          '',
        ]
      : []),
    'User prompt, for topic context only:',
    prompt || '(empty)',
  ].join('\n');
}

// ===== 3. 提取 HTML 文档 =====

/**
 * 从模型返回的文本中提取 HTML 文档。
 * 移植自 imagetoslice/server.js 的 extractHtmlDocument。
 */
function extractHtmlDocument(text: string): string {
  const raw = String(text || '')
    .trim()
    .replace(/^```(?:html)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const fullMatch =
    raw.match(/<!doctype html[\s\S]*<\/html>/i) || raw.match(/<html[\s\S]*<\/html>/i);
  if (fullMatch) {
    const html = fullMatch[0].trim();
    return /^<!doctype html/i.test(html) ? html : `<!doctype html>\n${html}`;
  }
  const bodyMatch = raw.match(/<body[\s\S]*<\/body>/i);
  if (bodyMatch) {
    return `<!doctype html><html><head><meta charset="UTF-8"></head>${bodyMatch[0]}</html>`;
  }
  return `<!doctype html><html><head><meta charset="UTF-8"></head><body>${raw}</body></html>`;
}

// ===== 4. Fallback HTML =====

function escapeHtmlAttribute(value: string): string {
  return String(value || '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return char;
    }
  });
}

// ===== 5. HTML 清洗器 =====
// 移植自 imagetoslice/src/server/services/fast-html-sanitizer.js

function positiveNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function sanitizeCssText(css: string): string {
  return String(css || '')
    .replace(
      /@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)|"[^"]*"|'[^']*')[^;]*;?/gi,
      '',
    )
    .replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
      (_match, dq: string, sq: string, uq: string) => {
        const value = String(dq || sq || uq || '').trim();
        return value.startsWith('#') ? `url(${value})` : 'none';
      },
    );
}

function sanitizeGeneratedCss(html: string): string {
  let safe = String(html || '').replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_match, attributes: string, css: string) => `<style${attributes}>${sanitizeCssText(css)}</style>`,
  );
  safe = safe.replace(
    /(\sstyle\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (_match, prefix: string, quote: string, css: string) =>
      `${prefix}${quote}${sanitizeCssText(css)}${quote}`,
  );
  return safe;
}

function readHtmlAttribute(tag: string, name: string): string {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(
    new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'),
  );
  return String(match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function sanitizeHtmlClassList(value: string): string {
  return String(value || '')
    .split(/\s+/)
    .filter((token) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(token))
    .join(' ');
}

function buildTrustedAssetTag(asset: { id: string; name: string }, originalTag: string): string {
  const className = sanitizeHtmlClassList(readHtmlAttribute(originalTag, 'class'));
  const alt = readHtmlAttribute(originalTag, 'alt') || asset.name || asset.id || 'reference_asset';
  const classAttribute = className ? ` class="${escapeHtmlAttribute(className)}"` : '';
  return `<img${classAttribute} src="asset:${escapeHtmlAttribute(asset.id)}" alt="${escapeHtmlAttribute(alt)}" data-reference-asset="${escapeHtmlAttribute(asset.id)}">`;
}

function buildFallbackAssetTag(asset: { id: string; name: string }, className: string): string {
  const id = escapeHtmlAttribute(asset.id || '');
  const alt = escapeHtmlAttribute(asset.name || asset.id || 'reference_asset');
  return `<img class="plugin-reference-fallback ${className}" src="asset:${id}" alt="${alt}" data-reference-asset="${id}">`;
}

function buildFallbackAssetRule(
  asset: { placement: { x: number; y: number; width: number; height: number }; radius: number },
  className: string,
  scaleX: number,
  scaleY: number,
): string {
  const p = asset.placement || {};
  const left = Math.round(Number(p.x || 0) * scaleX);
  const top = Math.round(Number(p.y || 0) * scaleY);
  const width = Math.max(1, Math.round(Number(p.width || 1) * scaleX));
  const height = Math.max(1, Math.round(Number(p.height || 1) * scaleY));
  const radius = Math.max(0, Math.round(Number(asset.radius || 0) * Math.min(scaleX, scaleY)));
  return `.${className}{position:absolute!important;left:${left}px!important;top:${top}px!important;width:${width}px!important;height:${height}px!important;border-radius:${radius}px!important;object-fit:contain!important;z-index:900;}`;
}

function sanitizeGeneratedUrlAttributes(html: string): string {
  return String(html || '').replace(/<[a-z][\w:-]*\b[^>]*>/gi, (tag) => {
    const withoutResource = tag.replace(
      /\s(?:src|srcset|href|xlink:href|action|formaction|poster|data|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
      (attribute: string, dq: string, sq: string, uq: string) => {
        const name = attribute.trimStart().split(/\s*=/, 1)[0].toLowerCase();
        const value = String(dq || sq || uq || '').trim();
        if ((name === 'href' || name === 'xlink:href') && value.startsWith('#')) {
          return attribute;
        }
        return '';
      },
    );
    return withoutResource.replace(
      /(\s(?:fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)\s*=\s*)(["'])([\s\S]*?)\2/gi,
      (_match: string, prefix: string, quote: string, value: string) =>
        `${prefix}${quote}${sanitizeCssText(value)}${quote}`,
    );
  });
}

function ensureFastPreviewShell(html: string): string {
  const canonicalShell =
    /<[a-z][\w:-]*\b[^>]*class\s*=\s*(["'])[^"']*\bfit-shell\b[^"']*\1[^>]*>\s*<[a-z][\w:-]*\b[^>]*class\s*=\s*(["'])[^"']*\bfit-box\b[^"']*\2[^>]*>\s*<[a-z][\w:-]*\b[^>]*class\s*=\s*(["'])[^"']*\bscreen\b[^"']*\3[^>]*>/i;
  if (canonicalShell.test(html)) return html;

  const screenOpen = /<([a-z][\w:-]*)\b[^>]*class\s*=\s*(["'])[^"']*\bscreen\b[^"']*\2[^>]*>/i;
  const opening = screenOpen.exec(html);
  if (!opening || /\/\s*>$/.test(opening[0])) return html;

  const tagName = opening[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let closingEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    if (/^<\//.test(match[0])) {
      depth -= 1;
      if (depth === 0) {
        closingEnd = tagPattern.lastIndex;
        break;
      }
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  if (closingEnd < 0) return html;

  return [
    html.slice(0, opening.index),
    '<main class="fit-shell"><div class="fit-box">',
    html.slice(opening.index, closingEnd),
    '</div></main>',
    html.slice(closingEnd),
  ].join('');
}

function injectAfterScreenOpen(html: string, payload: string): string {
  const screenOpen = /(<[^>]+class=(["'])[^"']*\bscreen\b[^"']*\2[^>]*>)/i;
  if (screenOpen.test(html)) {
    return html.replace(screenOpen, `$1${payload}`);
  }
  if (/<body\b[^>]*>/i.test(html)) {
    return html.replace(/<body\b([^>]*)>/i, `<body$1>${payload}`);
  }
  return `${payload}${html}`;
}

function injectIntoHead(html: string, payload: string): string {
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1><meta charset="UTF-8">${payload}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, `<html$1><head><meta charset="UTF-8">${payload}</head>`);
  }
  return `<!doctype html><html><head><meta charset="UTF-8">${payload}</head><body>${html}</body></html>`;
}

// ===== 5b. 多文件产物：解析 / 清洗 / 合成 =====

const REPLICA_STYLESHEET_HREF = './styles.css';
const REPLICA_SCRIPT_SRC = './script.js';

/** 三文件分隔符。容忍 = 与 - 的数量差异和大小写。 */
const REPLICA_FILE_MARKER = /^[=\-\s]*FILE:\s*(index\.html|styles\.css|script\.js)\s*[=\-\s]*$/i;
const REPLICA_END_MARKER = /^[=\-\s]*END[=\-\s]*$/i;

function stripCodeFences(text: string): string {
  return String(text || '')
    .replace(/^\s*```[a-z]*\s*\n?/i, '')
    .replace(/\n?\s*```\s*$/i, '')
    .trim();
}

/**
 * 解析模型输出的三文件。
 *
 * 降级策略：分隔符一个都没找到时，说明模型退回了单份 HTML 的老习惯，
 * 这时复用既有的 extractHtmlDocument + splitHtmlParts 拆成三份，
 * 而不是报错——用户拿到一个能用的页面，远好过看到一句"解析失败"。
 */
export function parseMultiFileOutput(text: string): ReplicaFiles {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const buckets: Record<ReplicaFilePath, string[]> = {
    'index.html': [],
    'styles.css': [],
    'script.js': [],
  };
  let current: ReplicaFilePath | null = null;
  let matchedAny = false;

  for (const line of raw.split('\n')) {
    const marker = line.match(REPLICA_FILE_MARKER);
    if (marker) {
      current = marker[1].toLowerCase() as ReplicaFilePath;
      matchedAny = true;
      continue;
    }
    if (matchedAny && REPLICA_END_MARKER.test(line)) {
      current = null;
      continue;
    }
    if (current) buckets[current].push(line);
  }

  if (matchedAny) {
    return {
      'index.html': stripCodeFences(buckets['index.html'].join('\n')),
      'styles.css': stripCodeFences(buckets['styles.css'].join('\n')),
      'script.js': stripCodeFences(buckets['script.js'].join('\n')),
    };
  }

  const parts = splitHtmlParts(extractHtmlDocument(raw));
  return {
    'index.html': parts.html,
    'styles.css': parts.css,
    'script.js': parts.script,
  };
}

/**
 * 移除会执行代码或加载外部资源的元素。
 *
 * 与单文件版的区别：这里把 <script> 和 <link> **全部**去掉，
 * 之后由 ensureReplicaLocalRefs 无条件补回规范化的本地引用。
 * 「先全删再补」比「按条件保留」少一整类边界情况——不会出现补出来的标签
 * 又被下一条正则二次匹配、最后留下半个 </script> 的问题。
 */
function stripUnsafeElementsForReplica(html: string): string {
  const blocked = [
    'script', 'iframe', 'object', 'embed', 'applet',
    'portal', 'frame', 'frameset', 'foreignObject',
    'animate', 'animateMotion', 'animateTransform', 'set',
  ];
  let safe = blocked.reduce((acc, tagName) => {
    const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return acc
      .replace(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}\\s*>`, 'gi'), '')
      .replace(new RegExp(`<${escaped}\\b[^>]*\\/?>`, 'gi'), '')
      .replace(new RegExp(`<\\/${escaped}\\s*>`, 'gi'), '');
  }, String(html || ''));

  safe = safe
    .replace(/<(?:link|base)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, (tag) =>
      readHtmlAttribute(tag, 'http-equiv').toLowerCase() === 'refresh' ? '' : tag,
    )
    .replace(/\son[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
  return safe;
}

function injectBeforeHeadEnd(html: string, payload: string): string {
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${payload}</head>`);
  return injectIntoHead(html, payload);
}

function injectBeforeBodyEnd(html: string, payload: string): string {
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${payload}</body>`);
  if (/<\/html\s*>/i.test(html)) return html.replace(/<\/html\s*>/i, `${payload}</html>`);
  return `${html}${payload}`;
}

/** 补回规范化的本地引用。上一步已把所有 link/script 删光，所以这里总是注入。 */
function ensureReplicaLocalRefs(html: string): string {
  let out = injectBeforeHeadEnd(html, `<link rel="stylesheet" href="${REPLICA_STYLESHEET_HREF}">`);
  out = injectBeforeBodyEnd(out, `<script src="${REPLICA_SCRIPT_SRC}" defer></script>`);
  return out;
}

/** 把 index.html 里残留的 <style> 抽到 styles.css，模型偶尔会忘记拆分 */
function extractInlineStyles(html: string): { html: string; css: string } {
  const collected: string[] = [];
  const stripped = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_match, css: string) => {
    collected.push(String(css || '').trim());
    return '';
  });
  return { html: stripped, css: collected.filter(Boolean).join('\n\n') };
}

export interface SanitizedReplicaFiles {
  files: ReplicaFiles;
  referenceAnchorCount: number;
  missingReferenceAnchorCount: number;
  qualityWarnings: string[];
}

/**
 * 清洗三文件产物：HTML 去可执行内容与外链、只保留已知切图锚点、补齐遗漏锚点；
 * CSS 去 @import 与远程 url()；JS 原样保留。
 *
 * 与单文件版的另一处关键差异：`.screen` 尺寸保护样式**不写进文件**，
 * 改由 composeReplicaPreview 在预览时注入。这样 agent 既看不到也删不掉它，
 * 三个文件保持干净，导出的产物也不带预览专用的 !important 补丁。
 */
export function sanitizeReplicaFiles(
  files: ReplicaFiles,
  referenceAssets: ReferenceAssetDescriptor[],
  dimensions: {
    previewWidth: number;
    previewHeight: number;
    sourceWidth: number;
    sourceHeight: number;
  },
): SanitizedReplicaFiles {
  const previewWidth = positiveNumber(dimensions.previewWidth, 1);
  const previewHeight = positiveNumber(dimensions.previewHeight, 1);
  const scaleX = previewWidth / positiveNumber(dimensions.sourceWidth, previewWidth);
  const scaleY = previewHeight / positiveNumber(dimensions.sourceHeight, previewHeight);

  const assets = new Map(
    referenceAssets
      .map((asset) => [String(asset.id || ''), asset] as const)
      .filter(([id]) => id),
  );
  const seen = new Set<string>();

  let html = stripUnsafeElementsForReplica(files['index.html']);
  const inline = extractInlineStyles(html);
  html = sanitizeGeneratedUrlAttributes(sanitizeGeneratedCss(inline.html));

  // 只保留已知切图资产的 <img>，丢弃模型自己发明的图片
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const id = readHtmlAttribute(tag, 'data-reference-asset');
    const asset = assets.get(id);
    if (!asset || seen.has(id)) return '';
    seen.add(id);
    return buildTrustedAssetTag(asset, tag);
  });
  html = ensureFastPreviewShell(html);

  // 为模型遗漏的切图资产补入 fallback 锚点，规则进 styles.css 供后续编辑
  const missingAssets = referenceAssets.filter(
    (asset) => asset?.id && asset?.placement && !seen.has(String(asset.id)),
  );
  const fallbackRules: string[] = [];
  if (missingAssets.length) {
    const fallbackTags = missingAssets
      .map((asset, index) => {
        const className = `plugin-reference-fallback-${index + 1}`;
        fallbackRules.push(buildFallbackAssetRule(asset, className, scaleX, scaleY));
        return buildFallbackAssetTag(asset, className);
      })
      .join('\n');
    html = injectAfterScreenOpen(html, `\n${fallbackTags}\n`);
    missingAssets.forEach((asset) => seen.add(String(asset.id)));
  }

  html = ensureReplicaLocalRefs(html);

  const cssParts = [sanitizeCssText(files['styles.css'])];
  if (inline.css) cssParts.push(sanitizeCssText(inline.css));
  if (fallbackRules.length) {
    cssParts.push(`/* 自动补入：模型遗漏的切图锚点定位 */\n${fallbackRules.join('\n')}`);
  }

  return {
    files: {
      'index.html': html,
      'styles.css': cssParts.filter((part) => part.trim()).join('\n\n'),
      'script.js': String(files['script.js'] || '').trim() || '// 本页暂无交互逻辑',
    },
    referenceAnchorCount: seen.size,
    missingReferenceAnchorCount: missingAssets.length,
    qualityWarnings: missingAssets.length
      ? [`模型遗漏 ${missingAssets.length} 个切图锚点，已按人工坐标补入。`]
      : [],
  };
}

/** `</script>` / `</style>` 出现在内联块里会提前闭合标签，必须转义 */
function escapeClosingTag(code: string, tagName: string): string {
  return String(code || '').replace(new RegExp(`</${tagName}`, 'gi'), `<\\/${tagName}`);
}

function buildPreviewGuardStyle(previewWidth: number, previewHeight: number): string {
  return [
    '<style data-fast-preview-guard>',
    'html,body{margin:0;padding:0;background:#eef0f4;}',
    'body{min-height:100vh;display:flex;justify-content:center;align-items:flex-start;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '*{box-sizing:border-box;}',
    `.screen{width:${previewWidth}px!important;min-width:${previewWidth}px!important;height:${previewHeight}px!important;min-height:${previewHeight}px!important;max-width:none;overflow:hidden;position:relative;flex:0 0 auto!important;padding:0!important;border:0!important;transform:none!important;}`,
    'img{display:block;}',
    '.screen [data-reference-asset]{position:absolute!important;object-fit:contain!important;object-position:center!important;background:transparent!important;}',
    '</style>',
  ].join('');
}

/**
 * 把三文件合成 iframe srcDoc 用的单份 HTML：
 * 内联 CSS/JS、注入尺寸保护样式、把 asset:<id> 换成真实 dataUrl。
 *
 * 保护样式必须放在作者样式**之后**才能靠 !important 压住 .screen 尺寸，
 * 所以用 injectBeforeHeadEnd 而不是 injectIntoHead。
 */
export function composeReplicaPreview(
  files: ReplicaFiles,
  assets: HydratedAsset[],
  dimensions: { previewWidth: number; previewHeight: number },
): string {
  const styleTag = `<style data-replica-styles>\n${escapeClosingTag(files['styles.css'], 'style')}\n</style>`;
  const scriptTag = `<script data-replica-script>\n${escapeClosingTag(files['script.js'], 'script')}\n</script>`;

  let html = String(files['index.html'] || '');

  const linkPattern = /<link\b[^>]*href\s*=\s*(["'])\.?\/?styles\.css\1[^>]*>/i;
  html = linkPattern.test(html)
    ? html.replace(linkPattern, styleTag)
    : injectBeforeHeadEnd(html, styleTag);

  html = injectBeforeHeadEnd(
    html,
    buildPreviewGuardStyle(
      positiveNumber(dimensions.previewWidth, 1),
      positiveNumber(dimensions.previewHeight, 1),
    ),
  );

  const scriptPattern = /<script\b[^>]*src\s*=\s*(["'])\.?\/?script\.js\1[^>]*>\s*<\/script\s*>/i;
  html = scriptPattern.test(html)
    ? html.replace(scriptPattern, scriptTag)
    : injectBeforeBodyEnd(html, scriptTag);

  return hydrateAssetHtml(html, assets);
}

/**
 * 读取工作区的三文件产物。
 * 旧记录只有单文件 reconstructedHtml 时，就地拆成三份——
 * 不需要 IndexedDB 版本升级，用户打开旧工作区不会看到空白。
 */
export function resolveReplicaFiles(
  workspace: Pick<SliceWorkspaceDraft, 'replicaFiles' | 'reconstructedHtml'> | null | undefined,
): ReplicaFiles | null {
  if (!workspace) return null;

  const stored = workspace.replicaFiles;
  if (stored && typeof stored === 'object') {
    return {
      'index.html': String(stored['index.html'] || ''),
      'styles.css': String(stored['styles.css'] || ''),
      'script.js': String(stored['script.js'] || ''),
    };
  }

  const legacy = workspace.reconstructedHtml;
  if (legacy && legacy.trim()) {
    const parts = splitHtmlParts(legacy);
    return {
      'index.html': parts.html,
      'styles.css': parts.css,
      'script.js': parts.script || '// 本页暂无交互逻辑',
    };
  }

  return null;
}

// ===== 6. AI 客户端：请求多文件网页复刻 =====

export interface ReplicaGenerationResult {
  files: ReplicaFiles;
  warning: string;
  /** API 回报的真实用量；上下文计数以此为准 */
  usage: NovaAgentUsage | null;
  metadata: {
    width: number;
    height: number;
    previewWidth: number;
    previewHeight: number;
    referenceAssetCount: number;
    referenceAnchorCount: number;
    missingReferenceAnchorCount: number;
  };
}

/**
 * 请求视觉模型把源图复刻成 index.html / styles.css / script.js 三个文件。
 *
 * 单次视觉调用，不走 agent 循环——首次生成是一件整体的事，拆成多步工具调用
 * 只会更慢更贵。后续的局部修改才交给 agent 按行编辑。
 *
 * 用 readNovaAgentStream 而不是 readNovaAgentTextStream，为的是拿到推理摘要与 usage：
 * 首个 HTML 增量到达前有几十秒的推理期，没有思考流的话界面就是一片空白。
 */
export async function requestReplicaGeneration(params: {
  sourceImageDataUrl: string;
  width: number;
  height: number;
  referenceAssets: ReferenceAssetDescriptor[];
  prompt?: string;
  signal?: AbortSignal;
  onStreamStart?: () => void;
  onPhase?: (phase: NovaAgentPhase) => void;
  onReasoningDelta?: (accumulated: string) => void;
  onDelta?: (delta: string, accumulated: string) => void;
}): Promise<ReplicaGenerationResult> {
  const { sourceImageDataUrl, width, height, referenceAssets, prompt, signal } = params;

  const textModel = requireSliceTextModel('sliceReconstruct');
  const protocol = textModel.protocol;
  const previewWidth = Math.round(width);
  const previewHeight = Math.max(1, Math.round(height * (previewWidth / width)));

  const promptText = buildEditableDesignH5Prompt({
    prompt: prompt || '',
    width,
    height,
    previewWidth,
    previewHeight,
    referenceAssets,
    multiFile: true,
  });

  params.onStreamStart?.();
  const response = await postNovaProxyText({
    protocol,
    baseUrl: textModel.baseUrl,
    apiKey: textModel.apiKey,
    model: textModel.modelId,
    stream: true,
    requestBody: buildNovaAgentRequestBody({
      protocol,
      model: textModel.modelId,
      stream: true,
      effort: RECONSTRUCT_REASONING_EFFORT,
      reasoningSummary: supportsReasoningSummary(protocol),
      maxOutputTokens: RECONSTRUCT_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: promptText },
            { type: 'image' as const, imageDataUrl: sourceImageDataUrl },
          ],
        },
      ],
    }),
    signal,
  });

  if (!response.ok) {
    throw await readHttpError(response);
  }

  const streamResult = await readNovaAgentStream(response, protocol, signal, {
    onPhase: params.onPhase,
    onReasoningDelta: (_delta, accumulated) => params.onReasoningDelta?.(accumulated),
    onText: params.onDelta,
  });

  const incompleteReason = getNovaAgentIncompleteReason(streamResult.finalPayload);
  if (incompleteReason === 'max_output_tokens') {
    throw new Error('模型输出超出长度上限，网页代码不完整，请降低推理强度或重试');
  }
  if (incompleteReason || !streamResult.complete) {
    throw new Error('模型流式响应提前结束，网页代码不完整，请重试');
  }
  if (!streamResult.text.trim()) {
    throw new Error('模型没有返回网页内容，请重试或更换文本模型');
  }

  const parsed = parseMultiFileOutput(streamResult.text);
  if (!parsed['index.html'].trim()) {
    throw new Error('模型返回的内容里没有 index.html，请重试');
  }

  const sanitized = sanitizeReplicaFiles(parsed, referenceAssets, {
    previewWidth,
    previewHeight,
    sourceWidth: width,
    sourceHeight: height,
  });

  return {
    files: sanitized.files,
    warning: sanitized.qualityWarnings.join(' '),
    usage: streamResult.usage,
    metadata: {
      width,
      height,
      previewWidth,
      previewHeight,
      referenceAssetCount: referenceAssets.length,
      referenceAnchorCount: sanitized.referenceAnchorCount,
      missingReferenceAnchorCount: sanitized.missingReferenceAnchorCount,
    },
  };
}

// ===== 7. 预览注入：替换 asset:id 为真实 dataUrl =====

/**
 * 将 HTML 中的 src="asset:<id>" 占位符替换为真实切图 dataUrl，用于 iframe 预览。
 */
export function hydrateAssetHtml(html: string, assets: HydratedAsset[]): string {
  const assetMap = new Map(assets.map((a) => [a.id, a] as const));
  return String(html || '').replace(
    /<img\b[^>]*\bdata-reference-asset=(["'])(.*?)\1[^>]*>/gi,
    (tag, _quote: string, rawId: string) => {
      const id = rawId;
      const asset = assetMap.get(id);
      if (!asset?.dataUrl) return tag;
      if (/\ssrc\s*=/i.test(tag)) {
        return tag.replace(
          /\ssrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
          ` src="${escapeHtmlAttribute(asset.dataUrl)}"`,
        );
      }
      return tag.replace(/<img/i, `<img src="${escapeHtmlAttribute(asset.dataUrl)}"`);
    },
  );
}

// ===== 8. 导出 HTML ZIP =====

/**
 * 将重建的 HTML 导出为 ZIP（index.html + styles.css + script.js + assets/*.png）。
 */
/**
 * 打包三文件 + 切图资产。index.html 里的 asset:<id> 换成 ./assets/ 相对路径。
 * 文件本来就是分开的，所以不再需要导出期的临时拆分。
 *
 * 只打包被 HTML 实际引用的资产：模型常常用不上全部切图（比如判断某个图标
 * 用 inline SVG 更合适），把未引用的也塞进 assets/ 只会让 ZIP 里多出一堆
 * 无人引用的死图，收到包的人无法判断哪些是有效素材。
 * 需要全部切图时应该走「导出切图包」，那才是资产清单的出口。
 */
export function buildReconstructZipFiles(
  files: ReplicaFiles,
  assets: HydratedAsset[],
): Record<string, Uint8Array> {
  const output: Record<string, Uint8Array> = {};
  let exportHtml = files['index.html'];
  const referenced = collectReferencedAssetIds(exportHtml);

  for (const asset of assets) {
    if (!referenced.has(asset.id)) continue;
    const ext = detectImageExtension(asset.dataUrl);
    const safeName = `asset-${asset.id.slice(0, 8)}.${ext}`;
    output[`assets/${safeName}`] = dataUrlToBytes(asset.dataUrl);
    exportHtml = exportHtml.replace(
      new RegExp(`src="asset:${escapeRegex(asset.id)}"`, 'gi'),
      `src="./assets/${safeName}"`,
    );
  }

  output['index.html'] = strToU8(exportHtml);
  output['styles.css'] = strToU8(files['styles.css']);
  output['script.js'] = strToU8(files['script.js']);
  return output;
}

export function exportReplicaZip(
  files: ReplicaFiles,
  assets: HydratedAsset[],
  workspaceNote?: string,
): void {
  const zipped = zipSync(buildReconstructZipFiles(files, assets), { level: 6 });
  const zipBlob = new Blob([zipped], { type: 'application/zip' });
  const name = (workspaceNote || 'reconstruct').replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]/g, '').slice(0, 40) || 'reconstruct';
  downloadBlob(zipBlob, `${name}-html.zip`);
}

function detectImageExtension(dataUrl: string): string {
  if (!dataUrl) return 'png';
  if (dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')) return 'jpg';
  if (dataUrl.startsWith('data:image/webp')) return 'webp';
  if (dataUrl.startsWith('data:image/svg')) return 'svg';
  return 'png';
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return new Uint8Array(0);
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将 HTML 中的 <style> 和 <script> 拆分到单独文件。
 * 简化版：只提取首个 <style> 块和 <body> 末尾的 <script> 块。
 */
function splitHtmlParts(html: string): { html: string; css: string; script: string } {
  let css = '';
  let script = '';
  let cleanHtml = html;

  // 提取 <style> 内容
  const styleMatch = cleanHtml.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
  if (styleMatch) {
    css = styleMatch[1];
    cleanHtml = cleanHtml.replace(
      /<style\b[^>]*>[\s\S]*?<\/style>/i,
      '<link rel="stylesheet" href="./styles.css">',
    );
  }

  // 提取 <script> 内容（注意 sanitizer 已移除了可执行 script，这里处理 fit 脚本）
  const scriptMatch = cleanHtml.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch) {
    script = scriptMatch[1];
    cleanHtml = cleanHtml.replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/i,
      '<script src="./script.js"><\/script>',
    );
  }

  return { html: cleanHtml, css, script };
}

// ===== 工具函数 =====

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Blob 转 dataUrl 失败'));
    reader.readAsDataURL(blob);
  });
}

async function readHttpError(response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = await response.text();
  } catch {
    /* ignore */
  }
  if (detail) {
    try {
      const parsed = JSON.parse(detail);
      const message = parsed?.error?.message || parsed?.error || parsed?.message;
      if (typeof message === 'string' && message.length > 0) {
        return new Error(`${response.status} ${response.statusText}: ${message}`);
      }
    } catch {
      /* not JSON */
    }
  }
  return new Error(
    `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
  );
}
