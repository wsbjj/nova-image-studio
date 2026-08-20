'use client';

import { useState } from 'react';
import { CheckCheck, Loader2, Square, SquareCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { SliceAsset } from '@/lib/slice-types';

import { useBlobUrl } from './use-blob-url';

/** 已裁剪好、等待用户确认是否落库的候选切图。 */
export interface DecomposeCandidate {
  asset: SliceAsset;
  confidence: number | null;
  reason: string;
}

interface DecomposeReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  candidates: DecomposeCandidate[];
  /** 工作区已有切图数量，>0 时提供「追加 / 替换」选择 */
  existingCount: number;
  busy?: boolean;
  onConfirm: (assets: SliceAsset[], mode: 'append' | 'replace') => void;
}

/**
 * AI 拆图结果确认弹窗。
 *
 * 移植版把 AI 返回的切图直接写进工作区，用户只能事后逐个删 —— 重复点一次「AI 拆图」
 * 就会堆一份重复资产。这里改为先确认再落库：
 * - 逐条勾选（缩略图 + 名称 + 类型 + 置信度 + 理由）
 * - 已有切图时可选「追加」或「替换」
 * - 整批落库计为一条历史，撤销一次即可全部移除
 */
export function DecomposeReviewDialog({
  open,
  onOpenChange,
  candidates,
  existingCount,
  busy,
  onConfirm,
}: DecomposeReviewDialogProps) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'append' | 'replace'>('append');

  // candidates 变化时重置勾选（渲染期调整，避免 effect + setState）
  const [lastCandidates, setLastCandidates] = useState(candidates);
  if (candidates !== lastCandidates) {
    setLastCandidates(candidates);
    setExcluded(new Set());
    setMode('append');
  }

  const toggle = (id: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selected = candidates.filter((c) => !excluded.has(c.asset.id));
  const allSelected = excluded.size === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>确认 AI 拆图结果</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            AI 识别到 {candidates.length} 个切图，勾选要保留的项目。
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setExcluded(allSelected ? new Set(candidates.map((c) => c.asset.id)) : new Set())
            }
          >
            <CheckCheck className="size-3.5" />
            {allSelected ? '全不选' : '全选'}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
          <ul className="divide-y divide-border">
            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.asset.id}
                candidate={candidate}
                checked={!excluded.has(candidate.asset.id)}
                onToggle={() => toggle(candidate.asset.id)}
              />
            ))}
          </ul>
        </div>

        {existingCount > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5">
            <span className="text-xs text-muted-foreground">
              工作区已有 {existingCount} 个切图：
            </span>
            {(
              [
                { value: 'append' as const, label: '追加' },
                { value: 'replace' as const, label: '替换全部' },
              ]
            ).map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={mode === option.value ? 'secondary' : 'ghost'}
                className="h-6 px-2 text-xs"
                onClick={() => setMode(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">已选 {selected.length} 个</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </Button>
            <Button
              onClick={() => onConfirm(selected.map((c) => c.asset), mode)}
              disabled={busy || selected.length === 0}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              {mode === 'replace' ? `替换为这 ${selected.length} 个` : `添加 ${selected.length} 个切图`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: DecomposeCandidate;
  checked: boolean;
  onToggle: () => void;
}) {
  const url = useBlobUrl(candidate.asset.currentBlobKey);
  const { asset, confidence, reason } = candidate;

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'flex w-full items-start gap-3 p-2 text-left transition-colors',
          checked ? 'bg-primary/5' : 'opacity-60 hover:opacity-100',
        )}
      >
        {checked ? (
          <SquareCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        ) : (
          <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}

        <div className="size-14 shrink-0 overflow-hidden rounded border border-border bg-muted">
          {url && (
            <img src={url} alt={asset.name} className="size-full object-contain" draggable={false} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-xs font-medium">{asset.name || '未命名'}</span>
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {asset.type}
            </Badge>
            {typeof confidence === 'number' && (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                {Math.round(confidence * 100)}%
              </Badge>
            )}
            <span className="text-[10px] text-muted-foreground">
              {Math.round(asset.placement.width)}×{Math.round(asset.placement.height)}
            </span>
          </div>
          {reason && (
            <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
              {reason}
            </p>
          )}
        </div>
      </button>
    </li>
  );
}
