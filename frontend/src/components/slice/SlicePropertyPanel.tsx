'use client';

import { useState } from 'react';
import { Link2, Unlink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  SLICE_RADIUS_CORNERS,
  getSliceFieldMax,
  getSliceRadii,
  type SliceRadiusCorner,
} from '@/lib/slice-geometry';
import type { SliceAsset, SliceScreen } from '@/lib/slice-types';

/** 切片类型选项（与 SliceAssetPanel 的 TYPE_LABELS 对齐） */
const TYPE_OPTIONS = [
  { value: 'manual_slice', label: '手动切图' },
  { value: 'illustration', label: '插画' },
  { value: 'icon', label: '图标' },
  { value: 'complex-decoration', label: '复杂装饰' },
  { value: 'product', label: '产品图' },
  { value: 'background', label: '背景' },
  { value: 'text', label: '文本' },
  { value: 'button', label: '按钮' },
  { value: 'card', label: '卡片' },
  { value: 'navigation', label: '导航' },
  { value: 'other', label: '其他' },
];

const CORNER_LABELS: Record<SliceRadiusCorner, string> = {
  topLeft: '左上',
  topRight: '右上',
  bottomRight: '右下',
  bottomLeft: '左下',
};

/** 多选时若各项取值不同，输入框显示空占位（源项目行为）。 */
const MIXED = '';

interface SlicePropertyPanelProps {
  /** 当前选中的切图（可多选） */
  selected: SliceAsset[];
  screen: SliceScreen;
  /** 局部更新：作用于全部选中项 */
  onUpdate: (ids: string[], patch: Partial<SliceAsset>) => void;
  onOpenInpaint: (id: string) => void;
  onRecrop: (ids: string[]) => void;
  /** 本地透明化（不消耗 AI 额度） */
  onTransparent: (ids: string[]) => void;
  onRestoreTransparency: (ids: string[]) => void;
  transparencyBusy?: boolean;
}

/**
 * 常驻切图属性面板（取代原先的 SliceSettingsDrawer 弹窗）。
 *
 * 相比弹窗的三点改进：
 * 1. 不遮挡画布 —— 改坐标时能同时看到框在动；
 * 2. 数字输入失焦/回车才提交，配合 store 的 mergeCommit 把连续输入合并成一条历史；
 * 3. 支持多选批量编辑，值不一致时显示空占位。
 */
export function SlicePropertyPanel({
  selected,
  screen,
  onUpdate,
  onOpenInpaint,
  onRecrop,
  onTransparent,
  onRestoreTransparency,
  transparencyBusy,
}: SlicePropertyPanelProps) {
  const ids = selected.map((a) => a.id);
  const single = selected.length === 1 ? selected[0] : null;
  const multi = selected.length > 1;

  /** 取所有选中项的共同值，不一致返回 null。 */
  function shared<T>(pick: (a: SliceAsset) => T): T | null {
    if (selected.length === 0) return null;
    const first = pick(selected[0]);
    return selected.every((a) => pick(a) === first) ? first : null;
  }

  const sharedName = shared((a) => a.name);
  const sharedType = shared((a) => a.type);
  const sharedX = shared((a) => Math.round(a.placement.x));
  const sharedY = shared((a) => Math.round(a.placement.y));
  const sharedW = shared((a) => Math.round(a.placement.width));
  const sharedH = shared((a) => Math.round(a.placement.height));

  // 四角圆角的共同值
  const radiiOf = (a: SliceAsset) => getSliceRadii(a, screen);
  const sharedRadii = SLICE_RADIUS_CORNERS.reduce<Record<SliceRadiusCorner, number | null>>(
    (acc, corner) => {
      acc[corner] = shared((a) => radiiOf(a)[corner]);
      return acc;
    },
    { topLeft: null, topRight: null, bottomRight: null, bottomLeft: null },
  );

  const [linkRadius, setLinkRadius] = useState(true);
  const allTransparent = selected.length > 0 && selected.every((a) => a.transparent);

  if (selected.length === 0) {
    return (
      <div className="border-t border-border px-3 py-4 text-center text-xs text-muted-foreground">
        选中一个切图以编辑其属性
      </div>
    );
  }

  const radiusMax = single
    ? getSliceFieldMax(single.placement, 'radius', screen)
    : Math.min(...selected.map((a) => getSliceFieldMax(a.placement, 'radius', screen)));

  const commitPlacement = (field: 'x' | 'y' | 'width' | 'height', raw: string) => {
    if (raw.trim() === '') return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    // 逐个应用：每个切图的合法上限取决于它自己的尺寸
    for (const asset of selected) {
      const max = getSliceFieldMax(asset.placement, field, screen);
      const min = field === 'width' || field === 'height' ? 1 : 0;
      const clamped = Math.round(Math.max(min, Math.min(value, max)));
      onUpdate([asset.id], { placement: { ...asset.placement, [field]: clamped } });
    }
  };

  const commitRadius = (corner: SliceRadiusCorner, raw: string) => {
    if (raw.trim() === '') return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    for (const asset of selected) {
      const max = getSliceFieldMax(asset.placement, 'radius', screen);
      const clamped = Math.round(Math.max(0, Math.min(value, max)));
      const current = getSliceRadii(asset, screen);
      const nextRadii = linkRadius
        ? { topLeft: clamped, topRight: clamped, bottomRight: clamped, bottomLeft: clamped }
        : { ...current, [corner]: clamped };
      onUpdate([asset.id], {
        radii: nextRadii,
        radius: Math.max(...SLICE_RADIUS_CORNERS.map((c) => nextRadii[c])),
      });
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">切图属性</h3>
        {multi && <span className="text-[10px] text-muted-foreground">批量编辑 {selected.length} 个</span>}
      </div>

      <Field label="名称">
        <CommitInput
          value={sharedName ?? MIXED}
          placeholder={multi && sharedName === null ? '多个值' : '未命名'}
          onCommit={(next) => {
            if (next.trim() === '') return;
            onUpdate(ids, { name: next });
          }}
        />
      </Field>

      <Field label="类型">
        <Select
          value={sharedType ?? ''}
          onValueChange={(v) => onUpdate(ids, { type: v })}
          options={
            sharedType === null ? [{ value: '', label: '多个值' }, ...TYPE_OPTIONS] : TYPE_OPTIONS
          }
        />
      </Field>

      <div className="grid grid-cols-2 gap-2">
        <Field label="X">
          <CommitInput
            type="number"
            value={sharedX === null ? MIXED : String(sharedX)}
            placeholder={sharedX === null ? '多个值' : undefined}
            onCommit={(next) => commitPlacement('x', next)}
          />
        </Field>
        <Field label="Y">
          <CommitInput
            type="number"
            value={sharedY === null ? MIXED : String(sharedY)}
            placeholder={sharedY === null ? '多个值' : undefined}
            onCommit={(next) => commitPlacement('y', next)}
          />
        </Field>
        <Field label="宽度">
          <CommitInput
            type="number"
            value={sharedW === null ? MIXED : String(sharedW)}
            placeholder={sharedW === null ? '多个值' : undefined}
            onCommit={(next) => commitPlacement('width', next)}
          />
        </Field>
        <Field label="高度">
          <CommitInput
            type="number"
            value={sharedH === null ? MIXED : String(sharedH)}
            placeholder={sharedH === null ? '多个值' : undefined}
            onCommit={(next) => commitPlacement('height', next)}
          />
        </Field>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">圆角 (最大 {radiusMax})</span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setLinkRadius((v) => !v)}
            title={linkRadius ? '当前：四角联动，点击改为独立' : '当前：四角独立，点击改为联动'}
            aria-label="切换四角联动"
          >
            {linkRadius ? (
              <Link2 className="size-3.5 text-primary" />
            ) : (
              <Unlink className="size-3.5" />
            )}
          </Button>
        </div>
        <div className={cn('grid gap-2', linkRadius ? 'grid-cols-1' : 'grid-cols-2')}>
          {linkRadius ? (
            <CommitInput
              type="number"
              value={
                sharedRadii.topLeft !== null &&
                SLICE_RADIUS_CORNERS.every((c) => sharedRadii[c] === sharedRadii.topLeft)
                  ? String(sharedRadii.topLeft)
                  : MIXED
              }
              placeholder="四角统一"
              onCommit={(next) => commitRadius('topLeft', next)}
            />
          ) : (
            SLICE_RADIUS_CORNERS.map((corner) => (
              <Field key={corner} label={CORNER_LABELS[corner]}>
                <CommitInput
                  type="number"
                  value={sharedRadii[corner] === null ? MIXED : String(sharedRadii[corner])}
                  placeholder={sharedRadii[corner] === null ? '多个值' : undefined}
                  onCommit={(next) => commitRadius(corner, next)}
                />
              </Field>
            ))
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => onRecrop(ids)}>
          重新裁剪
        </Button>
        {single && (
          <Button variant="outline" size="sm" className="flex-1" onClick={() => onOpenInpaint(single.id)}>
            AI 补齐
          </Button>
        )}
        {allTransparent ? (
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => onRestoreTransparency(ids)}
          >
            还原透明化
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            disabled={transparencyBusy}
            onClick={() => onTransparent(ids)}
            title="用本地算法移除纯色背景，不消耗 AI 额度"
          >
            {transparencyBusy ? '透明化中…' : '本地透明化'}
          </Button>
        )}
      </div>

      {single?.reason && (
        <p className="rounded-md bg-muted/50 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          AI 判定：{single.reason}
          {typeof single.confidence === 'number' && ` · 置信度 ${Math.round(single.confidence * 100)}%`}
        </p>
      )}
    </div>
  );
}

/**
 * 受控输入：编辑期间只改本地 state，失焦或回车才提交。
 *
 * 这样做的原因：原实现每个 onChange 都写 store，既产生大量中间历史，
 * 也会在输入 "10" 的过程中先用 "1" 触发一次重裁剪。
 */
function CommitInput({
  value,
  onCommit,
  type = 'text',
  placeholder,
}: {
  value: string;
  onCommit: (next: string) => void;
  type?: 'text' | 'number';
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  // 外部值变化（选中项切换、撤销、画布拖拽）时同步回输入框。
  // 这里用 React 官方的"渲染期根据 prop 变化调整 state"写法，而不是 useEffect + setState：
  // 后者会多一轮渲染，且触发 react-hooks/set-state-in-effect。
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  return (
    <Input
      type={type}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (draft !== value) onCommit(draft);
          (e.target as HTMLInputElement).blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
