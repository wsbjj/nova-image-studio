'use client';

import { useEffect, useRef } from 'react';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  Copy,
  Eye,
  EyeOff,
  Grid2x2,
  RotateCcw,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export interface SliceContextMenuProps {
  /** 视口坐标（clientX/clientY） */
  x: number;
  y: number;
  /** 右键命中的切图是否处于隐藏态 */
  hidden: boolean;
  /** 右键命中的切图是否已透明化 */
  transparent: boolean;
  /** 当前选中数量，用于显示"批量"文案 */
  selectedCount: number;
  onClose: () => void;
  onOpenSettings: () => void;
  onDuplicate: () => void;
  onToggleHidden: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onInpaint: () => void;
  onTransparent: () => void;
  onRestoreTransparency: () => void;
  onDelete: () => void;
}

/**
 * 切图右键菜单。
 * 用固定定位 + 视口边界翻转，避免菜单被画布右/下边缘裁掉。
 */
export function SliceContextMenu({
  x,
  y,
  hidden,
  transparent,
  selectedCount,
  onClose,
  onOpenSettings,
  onDuplicate,
  onToggleHidden,
  onBringToFront,
  onSendToBack,
  onInpaint,
  onTransparent,
  onRestoreTransparency,
  onDelete,
}: SliceContextMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // 点击别处 / 按 Esc / 滚动画布都关闭
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    // capture 阶段监听，保证在画布自己的 pointerdown 之前关掉菜单
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('wheel', onClose, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('wheel', onClose);
    };
  }, [onClose]);

  const multi = selectedCount > 1;
  const suffix = multi ? `（${selectedCount} 个）` : '';

  const items: Array<{
    key: string;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
    divider?: boolean;
  }> = [
    { key: 'settings', label: '切图设置', icon: <Settings2 className="size-3.5" />, onClick: onOpenSettings },
    { key: 'duplicate', label: `创建副本${suffix}`, icon: <Copy className="size-3.5" />, onClick: onDuplicate },
    {
      key: 'hidden',
      label: hidden ? `显示${suffix}` : `隐藏${suffix}`,
      icon: hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />,
      onClick: onToggleHidden,
    },
    { key: 'front', label: '置于顶层', icon: <ArrowUpToLine className="size-3.5" />, onClick: onBringToFront, divider: true },
    { key: 'back', label: '置于底层', icon: <ArrowDownToLine className="size-3.5" />, onClick: onSendToBack },
    { key: 'inpaint', label: 'AI 补齐', icon: <Sparkles className="size-3.5" />, onClick: onInpaint, divider: true },
    transparent
      ? { key: 'restore', label: `还原透明化${suffix}`, icon: <RotateCcw className="size-3.5" />, onClick: onRestoreTransparency }
      : { key: 'transparent', label: `本地透明化${suffix}`, icon: <Grid2x2 className="size-3.5" />, onClick: onTransparent },
    { key: 'delete', label: `删除${suffix}`, icon: <Trash2 className="size-3.5" />, onClick: onDelete, danger: true, divider: true },
  ];

  // 估算尺寸做边界翻转（菜单未挂载时拿不到真实尺寸）
  const estimatedWidth = 176;
  const estimatedHeight = items.length * 30 + 12;
  const left = typeof window !== 'undefined' && x + estimatedWidth > window.innerWidth
    ? Math.max(4, x - estimatedWidth)
    : x;
  const top = typeof window !== 'undefined' && y + estimatedHeight > window.innerHeight
    ? Math.max(4, y - estimatedHeight)
    : y;

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-md"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.key}>
          {item.divider && <div className="my-1 h-px bg-border" />}
          <button
            type="button"
            role="menuitem"
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
              item.danger
                ? 'text-destructive hover:bg-destructive/10'
                : 'hover:bg-muted',
            )}
            onClick={() => {
              item.onClick();
              onClose();
            }}
          >
            {item.icon}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
