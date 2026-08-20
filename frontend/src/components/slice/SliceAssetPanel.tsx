'use client';

import { useState } from 'react';
import {
  Copy,
  Eye,
  EyeOff,
  ImageIcon,
  Loader2,
  RotateCcw,
  Shapes,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { getSliceRadii } from '@/lib/slice-geometry';
import { isProcessOpActive, PROCESS_OP_LABELS } from '@/lib/slice-process-state';
import type { SliceAsset, SliceProcessOp, SliceScreen, SliceWorkspaceDraft } from '@/lib/slice-types';

import { useBlobUrl } from './use-blob-url';

/** 切片类型 → 中文标签 */
const TYPE_LABELS: Record<string, string> = {
  manual_slice: '手动切图',
  illustration: '插画',
  icon: '图标',
  'complex-decoration': '复杂装饰',
  product: '产品图',
  background: '背景',
  text: '文本',
  button: '按钮',
  card: '卡片',
  navigation: '导航',
  other: '其他',
};

/** AI 补齐双结果的角色 → 中文标签。列表里必须能区分，否则两条同名资产无从选择。 */
const VARIANT_ROLE_LABELS: Record<string, string> = {
  composite: '局部合成',
  raw: 'AI 原图',
};

/**
 * 圆角摘要：四角相同显示 R8，不同显示 R8/8/0/0，全 0 不显示。
 * 与上游 formatSliceRadiiLabel 一致。
 */
function formatRadiiLabel(asset: SliceAsset, screen: SliceScreen): string {
  const radii = getSliceRadii(asset, screen);
  const values = [radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft];
  if (values.every((v) => v === 0)) return '';
  return values.every((v) => v === values[0]) ? `R${values[0]}` : `R${values.join('/')}`;
}

interface SliceAssetPanelProps {
  workspace: SliceWorkspaceDraft;
  selectedIds: Set<string>;
  onSelect: (id: string, multi: boolean) => void;
  onCopy: (id: string) => void;
  onDelete: (ids: string[]) => void;
  onOpenSettings: (id: string) => void;
  onOpenInpaint: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** 执行某个处理操作（算法类可批量，AI 类由本组件保证只传单个 id） */
  onRunOp: (op: SliceProcessOp, id: string) => void;
  /** 还原某个处理操作 */
  onRestoreOp: (op: SliceProcessOp, id: string) => void;
  /** 算法类处理进行中（禁用相关入口） */
  processBusy?: boolean;
  /** 正在进行的 AI 处理：仅该资产显示进度与取消 */
  aiOp?: { id: string; op: 'aiTransparent' | 'aiSvg'; elapsed: number } | null;
  onCancelAiOp?: () => void;
}

/**
 * 右侧切图资产列表侧栏。
 * - 缩略图（currentBlobKey → objectURL）
 * - 点击选中（Ctrl/⌘ + click 多选），与画布选中联动；点击行本身即进入设置，故不再单独放设置按钮
 * - 行内「透明」「SVG」两个下拉，各含算法版与 AI 版，已生效时变为还原
 * - 复制 / 删除（带确认）/ 显隐 / AI 补齐入口
 * - 拖拽排序（HTML5 DnD，改变 assets 数组顺序，不影响画布坐标）
 */
export function SliceAssetPanel({
  workspace,
  selectedIds,
  onSelect,
  onCopy,
  onDelete,
  onOpenSettings,
  onOpenInpaint,
  onToggleHidden,
  onReorder,
  onRunOp,
  onRestoreOp,
  processBusy,
  aiOp,
  onCancelAiOp,
}: SliceAssetPanelProps) {
  const assets = workspace.assets;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<string[] | null>(null);

  const handleDeleteClick = (id: string) => {
    const ids = selectedIds.has(id) && selectedIds.size > 0 ? Array.from(selectedIds) : [id];
    setConfirmDeleteIds(ids);
  };

  return (
    <aside className="flex h-full min-h-0 w-72 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h3 className="text-sm font-semibold">切图资产</h3>
        <span className="text-xs text-muted-foreground">{assets.length} 个</span>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
        {assets.length === 0 ? (
          <div className="grid place-items-center px-4 py-12 text-center text-xs text-muted-foreground">
            暂无切图
            <br />
            点击「AI 拆图」或在画布上框选生成切图
          </div>
        ) : (
          <ul className="space-y-0.5 p-1.5">
            {assets.map((asset, index) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                screen={workspace.screen}
                selected={selectedIds.has(asset.id)}
                isDragOver={overIndex === index && dragIndex !== null && dragIndex !== index}
                onSelect={onSelect}
                onCopy={onCopy}
                onDelete={handleDeleteClick}
                onOpenSettings={onOpenSettings}
                onOpenInpaint={onOpenInpaint}
                onToggleHidden={onToggleHidden}
                onRunOp={onRunOp}
                onRestoreOp={onRestoreOp}
                processBusy={processBusy}
                aiOp={aiOp?.id === asset.id ? aiOp : null}
                onCancelAiOp={onCancelAiOp}
                onDragStart={() => setDragIndex(index)}
                onDragEnter={() => setOverIndex(index)}
                onDragEnd={() => {
                  if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
                    onReorder(dragIndex, overIndex);
                  }
                  setDragIndex(null);
                  setOverIndex(null);
                }}
              />
            ))}
          </ul>
        )}
      </div>

      {selectedIds.size > 0 && (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          已选中 {selectedIds.size} 个
        </div>
      )}

      <Dialog open={confirmDeleteIds !== null} onOpenChange={(open) => !open && setConfirmDeleteIds(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除切图</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            确定删除选中的 {confirmDeleteIds?.length ?? 0} 个切图吗？此操作无法撤销。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteIds(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDeleteIds) onDelete(confirmDeleteIds);
                setConfirmDeleteIds(null);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

interface AssetRowProps {
  asset: SliceAsset;
  screen: SliceScreen;
  selected: boolean;
  isDragOver: boolean;
  onSelect: (id: string, multi: boolean) => void;
  onCopy: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: (id: string) => void;
  onOpenInpaint: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onRunOp: (op: SliceProcessOp, id: string) => void;
  onRestoreOp: (op: SliceProcessOp, id: string) => void;
  processBusy?: boolean;
  aiOp?: { id: string; op: 'aiTransparent' | 'aiSvg'; elapsed: number } | null;
  onCancelAiOp?: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onDragEnd: () => void;
}

function AssetRow({
  asset,
  screen,
  selected,
  isDragOver,
  onSelect,
  onCopy,
  onDelete,
  onOpenSettings,
  onOpenInpaint,
  onToggleHidden,
  onRunOp,
  onRestoreOp,
  processBusy,
  aiOp,
  onCancelAiOp,
  onDragStart,
  onDragEnter,
  onDragEnd,
}: AssetRowProps) {
  const thumbUrl = useBlobUrl(asset.currentBlobKey);
  const radiiLabel = formatRadiiLabel(asset, screen);
  const variantLabel = asset.aiVariantRole ? VARIANT_ROLE_LABELS[asset.aiVariantRole] : '';
  // AI 处理进行中：锁住这一行，避免拖拽 / 删除 / 再次触发把进行中的请求搞乱
  const aiBusy = aiOp !== null && aiOp !== undefined;

  return (
    <li
      draggable={!aiBusy}
      onDragStart={(e) => {
        if (aiBusy) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        onDragEnter();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnd={onDragEnd}
      onDrop={(e) => e.preventDefault()}
      onClick={(e) => onSelect(asset.id, e.ctrlKey || e.metaKey)}
      onDoubleClick={() => onOpenSettings(asset.id)}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-md p-1.5 transition-colors',
        selected ? 'bg-primary/10 ring-1 ring-primary/40' : 'hover:bg-muted',
        isDragOver && 'border-t-2 border-primary',
        asset.hidden && 'opacity-50',
        aiBusy && 'cursor-wait opacity-70',
      )}
    >
      <div className="size-10 shrink-0 overflow-hidden rounded bg-muted">
        {thumbUrl ? (
          <img src={thumbUrl} alt={asset.name} className="size-full object-contain" draggable={false} />
        ) : (
          <div className="grid size-full place-items-center text-muted-foreground">
            <ImageIcon className="size-4" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="line-clamp-1 text-xs font-medium">{asset.name || '未命名'}</div>
        {/* 尺寸与圆角：判断框选是否准确时最先要看的两个数 */}
        <div className="mt-0.5 line-clamp-1 text-[10px] tabular-nums text-muted-foreground">
          {Math.round(asset.placement.width)}×{Math.round(asset.placement.height)}
          {radiiLabel && ` · ${radiiLabel}`}
        </div>
        {aiBusy ? (
          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-primary">
            <Loader2 className="size-3 animate-spin" />
            {PROCESS_OP_LABELS[aiOp.op]} · {aiOp.elapsed}s
            <button
              type="button"
              className="rounded p-0.5 hover:bg-muted"
              onClick={(e) => {
                e.stopPropagation();
                onCancelAiOp?.();
              }}
              title="取消"
              aria-label="取消"
            >
              <X className="size-3" />
            </button>
          </div>
        ) : (
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {TYPE_LABELS[asset.type] || asset.type}
            </Badge>
            {asset.aiCompleted && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-primary">
                AI补齐{variantLabel && `·${variantLabel}`}
              </Badge>
            )}
            {isProcessOpActive(asset, 'transparent') && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                透明
              </Badge>
            )}
            {isProcessOpActive(asset, 'aiTransparent') && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-primary">
                AI透明
              </Badge>
            )}
            {isProcessOpActive(asset, 'svg') && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                SVG
              </Badge>
            )}
            {isProcessOpActive(asset, 'aiSvg') && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-primary">
                AI SVG
              </Badge>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {/* 透明：算法版 + AI 版，各自独立可还原 */}
        <OpMenu
          asset={asset}
          icon={<Square className="size-3.5" />}
          label="透明"
          localOp="transparent"
          aiOp="aiTransparent"
          disabled={aiBusy || Boolean(processBusy)}
          onRunOp={onRunOp}
          onRestoreOp={onRestoreOp}
        />
        {/* SVG：算法追踪 + AI 重绘 */}
        <OpMenu
          asset={asset}
          icon={<Shapes className="size-3.5" />}
          label="SVG"
          localOp="svg"
          aiOp="aiSvg"
          disabled={aiBusy || Boolean(processBusy)}
          onRunOp={onRunOp}
          onRestoreOp={onRestoreOp}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={aiBusy}
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden(asset.id);
          }}
          title={asset.hidden ? '显示' : '隐藏'}
        >
          {asset.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={aiBusy}
          onClick={(e) => {
            e.stopPropagation();
            onOpenInpaint(asset.id);
          }}
          title="AI 补齐"
        >
          <Sparkles className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={aiBusy}
          onClick={(e) => {
            e.stopPropagation();
            onCopy(asset.id);
          }}
          title="复制"
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={aiBusy}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(asset.id);
          }}
          title="删除"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  );
}

/**
 * 一组「算法版 / AI 版」处理入口。
 *
 * 已生效的那一项显示为「还原」，未生效的显示为执行 —— 与上游一致：
 * 同一个按钮兼任执行与还原，省一半按钮，且状态一眼可见。
 * AI 项标注「消耗额度」，因为它和相邻的算法项代价差一个数量级。
 */
function OpMenu({
  asset,
  icon,
  label,
  localOp,
  aiOp,
  disabled,
  onRunOp,
  onRestoreOp,
}: {
  asset: SliceAsset;
  icon: React.ReactNode;
  label: string;
  localOp: SliceProcessOp;
  aiOp: SliceProcessOp;
  disabled: boolean;
  onRunOp: (op: SliceProcessOp, id: string) => void;
  onRestoreOp: (op: SliceProcessOp, id: string) => void;
}) {
  const localActive = isProcessOpActive(asset, localOp);
  const aiActive = isProcessOpActive(asset, aiOp);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        onClick={(e) => e.stopPropagation()}
        title={`${label}处理`}
        aria-label={`${label}处理`}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'icon-xs' }),
          (localActive || aiActive) && 'text-primary',
        )}
      >
        {icon}
      </DropdownMenuTrigger>
      {/* 内容宽度默认跟随触发器（--anchor-width），图标按钮太窄，这里显式给下限 */}
      <DropdownMenuContent align="end" className="min-w-40" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onClick={() => (localActive ? onRestoreOp(localOp, asset.id) : onRunOp(localOp, asset.id))}
        >
          {localActive ? (
            <>
              <RotateCcw className="size-3.5" />
              还原{PROCESS_OP_LABELS[localOp]}
            </>
          ) : (
            <>
              {icon}
              {PROCESS_OP_LABELS[localOp]}
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => (aiActive ? onRestoreOp(aiOp, asset.id) : onRunOp(aiOp, asset.id))}
        >
          {aiActive ? (
            <>
              <RotateCcw className="size-3.5" />
              还原{PROCESS_OP_LABELS[aiOp]}
            </>
          ) : (
            <>
              <Sparkles className="size-3.5" />
              {PROCESS_OP_LABELS[aiOp]}
              <span className="ml-auto text-[10px] text-muted-foreground">消耗额度</span>
            </>
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
