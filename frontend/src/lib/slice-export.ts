// UI 设计模式的切图包与完整包导入/导出。
// 切图包保留 manifest + assets；完整包额外包含源图、工作区元数据和网页文件。

import { strToU8, zipSync } from 'fflate';

import { readZip } from '@/components/canvas/lib/zip';
import { downloadBlob } from './backup-utils';
import { getBlob, putBlob } from './slice-db';
import { getSliceRadii } from './slice-geometry';
import {
  buildReconstructZipFiles,
  resolveReplicaFiles,
  type HydratedAsset,
} from './slice-reconstruct';
import type { ReplicaFiles } from './web-agent/vfs';
import type { SliceAsset, SliceRadii, SliceScreen, SliceSource, SliceWorkspaceDraft } from './slice-types';

/** manifest 中单条资产的导出描述。 */
export interface SliceManifestAsset {
  id: string;
  name: string;
  filename: string;
  format: 'png';
  /** 同时导出矢量时的 .svg 路径；无矢量数据时为 null */
  svgFilename?: string | null;
  /** 该资产实际导出的格式列表，便于消费方直接判断有没有矢量版 */
  formats?: string[];
  /** svgData 来自 AI 重绘（true）还是本地算法矢量化（false） */
  svgFromAi?: boolean;
  transparent: boolean;
  aiTransparent: boolean;
  aiCompleted: boolean;
  radius: number;
  radii: SliceRadii;
  source: string;
  variantGroupId?: string;
  variantRole?: string;
  placement: SliceAsset['placement'];
}

/** 切图包 manifest 结构。 */
export interface SliceManifest {
  version: string;
  exportedAt: string;
  screen: SliceScreen;
  assets: SliceManifestAsset[];
}

export interface ImportedSlicePackage {
  sourceBlob: Blob;
  screen: SliceScreen;
  assets: SliceAsset[];
  note: string;
  /** 网页复刻三文件。旧包只有单文件 reconstructedHtml 时在导入处拆分。 */
  replicaFiles: ReplicaFiles | null;
}

interface PackageFiles {
  files: Record<string, Uint8Array>;
  manifest: SliceManifest;
}

/** 规范化文件名：只保留中文、字母、数字、-、_，其余字符移除。 */
function sanitizeFilename(name: string, fallbackIndex: number): string {
  const cleaned = name.replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]/g, '').trim();
  return cleaned || `slice_${fallbackIndex}`;
}

/** 在已用名称集合中生成不冲突的文件名。 */
function uniqueFilename(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  const next = `${base}_${suffix}`;
  taken.add(next);
  return next;
}

function getImageExtension(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  return 'png';
}

function mimeFromFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function buildManifestAsset(
  asset: SliceAsset,
  filename: string,
  screen: SliceScreen,
  svgFilename: string | null,
): SliceManifestAsset {
  const radii = getSliceRadii(asset, screen);
  return {
    id: asset.id,
    name: asset.name,
    filename,
    format: 'png',
    // 有矢量版时一并声明，消费方（Figma 导入、二次开发）据此选用 svg 而不是位图
    ...(svgFilename
      ? { svgFilename, formats: ['png', 'svg'], svgFromAi: Boolean(asset.svgFromAi) }
      : { svgFilename: null, formats: ['png'] }),
    transparent: asset.transparent,
    aiTransparent: asset.aiTransparent,
    aiCompleted: asset.aiCompleted,
    radius: Math.max(radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft),
    radii,
    source: asset.source ?? 'manual',
    ...(asset.aiVariantGroupId ? { variantGroupId: asset.aiVariantGroupId } : {}),
    ...(asset.aiVariantRole ? { variantRole: asset.aiVariantRole } : {}),
    placement: { ...asset.placement },
  };
}

async function buildSlicePackageFiles(workspace: SliceWorkspaceDraft): Promise<PackageFiles> {
  const visibleAssets = workspace.assets.filter((asset) => !asset.hidden);
  if (visibleAssets.length === 0) {
    throw new Error('当前没有已完成的切图，无法导出');
  }

  const files: Record<string, Uint8Array> = {};
  const manifestAssets: SliceManifestAsset[] = [];
  const takenNames = new Set<string>();

  for (const [index, asset] of visibleAssets.entries()) {
    if (asset.source === 'ai-background' && !asset.aiCompleted) {
      throw new Error(`AI 背景“${asset.name || index + 1}”生成未完成，无法导出`);
    }
    const blob = await getBlob(asset.currentBlobKey);
    if (!blob) {
      throw new Error(`切图“${asset.name || index + 1}”数据缺失，请重新切图后再导出`);
    }
    const safeName = uniqueFilename(sanitizeFilename(asset.name || '', index + 1), takenNames);
    const filename = `assets/${safeName}.png`;
    files[filename] = new Uint8Array(await blob.arrayBuffer());

    // 有矢量数据时并列导出 .svg —— 位图仍然导出，因为不是所有消费方都能吃矢量
    let svgFilename: string | null = null;
    if (asset.svgData && asset.svgData.trim()) {
      svgFilename = `assets/${safeName}.svg`;
      files[svgFilename] = strToU8(asset.svgData);
    }

    manifestAssets.push(buildManifestAsset(asset, filename, workspace.screen, svgFilename));
  }

  const manifest: SliceManifest = {
    version: '1.1.0',
    exportedAt: new Date().toISOString(),
    screen: { width: workspace.screen.width, height: workspace.screen.height },
    assets: manifestAssets,
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return { files, manifest };
}

function downloadZip(files: Record<string, Uint8Array>, filename: string): void {
  const zipped = zipSync(files, { level: 6 });
  downloadBlob(new Blob([zipped], { type: 'application/zip' }), filename);
}

/** 导出切图包（manifest.json + assets/*.png）。 */
export async function exportSlicePackage(workspace: SliceWorkspaceDraft): Promise<void> {
  const { files } = await buildSlicePackageFiles(workspace);
  downloadZip(files, `slice-export-${workspace.id.slice(0, 8)}-${Date.now()}.zip`);
}

/**
 * 导出完整 UI 设计包：源图、切图 manifest、工作区元数据，以及已经生成的网页文件。
 * 网页文件使用 web/ 前缀，避免与切图包的 assets/ 混淆。
 */
export async function exportFullPackage(
  workspace: SliceWorkspaceDraft,
  hydratedAssets: HydratedAsset[],
): Promise<void> {
  const replicaFiles = resolveReplicaFiles(workspace);
  if (!replicaFiles?.['index.html'].trim()) {
    throw new Error('网页复刻尚未成功生成，无法导出完整包');
  }
  const visibleAssetCount = workspace.assets.filter((asset) => !asset.hidden).length;
  if (hydratedAssets.length !== visibleAssetCount) {
    throw new Error('部分切图数据缺失，疑似 AI 切图失败，请修复后再导出');
  }
  const { files, manifest } = await buildSlicePackageFiles(workspace);
  const sourceBlob = await getBlob(workspace.sourceImageBlobKey);
  if (!sourceBlob) throw new Error('源图数据缺失，无法导出完整包');

  const sourceExtension = getImageExtension(sourceBlob.type || 'image/png');
  files[`source.${sourceExtension}`] = new Uint8Array(await sourceBlob.arrayBuffer());
  files['workspace.json'] = strToU8(JSON.stringify({
    app: 'ccode-ui-design',
    // v2 起网页产物是三个文件；v1 的 reconstructedHtml 在导入时仍会被拆分识别
    version: 2,
    id: workspace.id,
    note: workspace.note,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    screen: manifest.screen,
    replicaFiles,
  }, null, 2));

  const webFiles = buildReconstructZipFiles(replicaFiles, hydratedAssets);
  for (const [name, data] of Object.entries(webFiles)) {
    // index.html 位于 web/，而切图资产位于完整包根目录的 assets/。
    // 调整相对路径，保证解压后直接打开 web/index.html 仍能显示图片。
    const output = name === 'index.html'
      ? strToU8(new TextDecoder().decode(data).replaceAll('./assets/', '../assets/'))
      : data;
    files[`web/${name}`] = output;
  }

  const safeNote = sanitizeFilename(workspace.note || 'ui-design', 1).slice(0, 40);
  downloadZip(files, `${safeNote}-complete-${Date.now()}.zip`);
}

function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function findZipEntry(entries: Map<string, Blob>, requested: string): Blob | null {
  const normalized = normalizeZipPath(requested);
  const exact = entries.get(normalized) || entries.get(requested);
  if (exact) return exact;
  const suffix = `/${normalized}`;
  for (const [name, blob] of entries) {
    const candidate = normalizeZipPath(name);
    if (candidate === normalized || candidate.endsWith(suffix)) return blob;
  }
  return null;
}

function findSourceEntry(entries: Map<string, Blob>): { blob: Blob; name: string } | null {
  for (const [name, blob] of entries) {
    const normalized = normalizeZipPath(name);
    if (/(^|\/)source\.(png|jpe?g|webp|gif)$/i.test(normalized)) return { blob, name: normalized };
  }
  return null;
}

async function cloneZipBlob(blob: Blob, filename: string): Promise<Blob> {
  const type = blob.type && blob.type !== 'application/octet-stream'
    ? blob.type
    : mimeFromFilename(filename);
  return new Blob([await blob.arrayBuffer()], { type });
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function readPlacement(value: unknown): SliceAsset['placement'] {
  const placement = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const result = {
    x: Number(placement.x),
    y: Number(placement.y),
    width: Number(placement.width),
    height: Number(placement.height),
  };
  if (![result.x, result.y, result.width, result.height].every(Number.isFinite) || result.width <= 0 || result.height <= 0) {
    throw new Error('切图包包含无效的切图坐标');
  }
  return result;
}

async function composeSourceBlob(
  screen: SliceScreen,
  assets: Array<{ blob: Blob; placement: SliceAsset['placement'] }>,
): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('当前环境无法重建切图包源图');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(screen.width));
  canvas.height = Math.max(1, Math.round(screen.height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前环境无法重建切图包源图');
  context.clearRect(0, 0, canvas.width, canvas.height);

  for (const item of assets) {
    const url = URL.createObjectURL(item.blob);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('切图包中的图片无法读取'));
        element.src = url;
      });
      const p = item.placement;
      context.drawImage(image, p.x, p.y, p.width, p.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('无法生成切图包预览图'));
    }, 'image/png');
  });
}

/**
 * 导入完整包或切图包。没有 source.* 的旧切图包会用切图坐标合成透明源图，
 * 因此仍然可以在 UI 设计模式中继续调整和导出。
 */
export async function importSliceWorkspacePackage(file: Blob): Promise<ImportedSlicePackage> {
  const entries = await readZip(file);
  const manifestBlob = findZipEntry(entries, 'manifest.json');
  if (!manifestBlob) throw new Error('缺少 manifest.json，不是 UI 设计模式切图包');

  let manifest: Partial<SliceManifest>;
  try {
    manifest = JSON.parse(await manifestBlob.text()) as Partial<SliceManifest>;
  } catch {
    throw new Error('切图包的 manifest.json 无法解析');
  }

  const rawScreen = (manifest.screen && typeof manifest.screen === 'object' ? manifest.screen : {}) as Partial<SliceScreen>;
  if (!isFinitePositive(rawScreen.width) || !isFinitePositive(rawScreen.height) || !Array.isArray(manifest.assets)) {
    throw new Error('切图包的屏幕尺寸或资产列表无效');
  }
  const screen: SliceScreen = { width: Math.round(rawScreen.width), height: Math.round(rawScreen.height) };
  if (manifest.assets.length === 0) throw new Error('切图包没有可用切图资产');

  const importedAssets: SliceAsset[] = [];
  const composeAssets: Array<{ blob: Blob; placement: SliceAsset['placement'] }> = [];
  for (const [index, rawValue] of manifest.assets.entries()) {
    const raw = (rawValue && typeof rawValue === 'object' ? rawValue : {}) as Partial<SliceManifestAsset>;
    const filename = typeof raw.filename === 'string' ? raw.filename : '';
    const entry = filename ? findZipEntry(entries, filename) : null;
    if (!entry) throw new Error(`切图包缺少资产文件：${filename || index + 1}`);
    const blob = await cloneZipBlob(entry, filename);
    const key = await putBlob(blob, blob.type || 'image/png');
    if (!key) throw new Error(`切图包资产“${filename || index + 1}”保存失败`);
    const placement = readPlacement(raw.placement);
    const radii = raw.radii && typeof raw.radii === 'object' ? raw.radii as SliceRadii : undefined;
    const source = raw.source === 'ai-asset' || raw.source === 'ai-background' ? raw.source : 'manual';

    // 矢量版是文本条目，缺失时按「只有位图」导入，不报错：
    // 旧版本导出的包没有 svgFilename，manifest 里也读不到。
    let svgData: string | null = null;
    if (typeof raw.svgFilename === 'string' && raw.svgFilename) {
      const svgEntry = findZipEntry(entries, raw.svgFilename);
      if (svgEntry) {
        const text = (await svgEntry.text()).trim();
        if (text) svgData = text;
      }
    }

    importedAssets.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : `imported-${index + 1}`,
      name: typeof raw.name === 'string' && raw.name ? raw.name : `导入切图 ${index + 1}`,
      type: 'other',
      placement,
      radius: Number.isFinite(raw.radius) ? Number(raw.radius) : 0,
      radii,
      source: source as SliceSource,
      transparent: Boolean(raw.transparent),
      aiTransparent: Boolean(raw.aiTransparent),
      aiCompleted: Boolean(raw.aiCompleted),
      hidden: false,
      originalBlobKey: key,
      currentBlobKey: key,
      ...(svgData ? { svgData, svgFromAi: Boolean(raw.svgFromAi) } : {}),
      ...(typeof raw.variantGroupId === 'string' ? { aiVariantGroupId: raw.variantGroupId } : {}),
      ...(typeof raw.variantRole === 'string' && (raw.variantRole === 'composite' || raw.variantRole === 'raw')
        ? { aiVariantRole: raw.variantRole }
        : {}),
    });
    composeAssets.push({ blob, placement });
  }

  const sourceEntry = findSourceEntry(entries);
  const sourceBlob = sourceEntry
    ? await cloneZipBlob(sourceEntry.blob, sourceEntry.name)
    : await composeSourceBlob(screen, composeAssets);

  let note = '导入的 UI 设计';
  let replicaFiles: ReplicaFiles | null = null;
  const workspaceBlob = findZipEntry(entries, 'workspace.json');
  if (workspaceBlob) {
    try {
      const metadata = JSON.parse(await workspaceBlob.text()) as {
        note?: unknown;
        replicaFiles?: unknown;
        reconstructedHtml?: unknown;
      };
      if (typeof metadata.note === 'string' && metadata.note.trim()) note = metadata.note.trim();
      // v2 包直接带三文件；v1 包只有单份 HTML，交给 resolveReplicaFiles 拆分
      replicaFiles = resolveReplicaFiles({
        replicaFiles: (metadata.replicaFiles ?? null) as SliceWorkspaceDraft['replicaFiles'],
        reconstructedHtml:
          typeof metadata.reconstructedHtml === 'string' ? metadata.reconstructedHtml : null,
      });
    } catch {
      // 完整包元数据损坏时仍允许按切图包导入。
    }
  }

  return { sourceBlob, screen, assets: importedAssets, note, replicaFiles };
}
