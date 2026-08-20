// 切图编辑器键盘快捷键
//
// 关键设计：不使用 window 级监听。
// WorkspaceShell 里所有 Tab 都是 keepMounted，CanvasEditor 的 window keydown 会一直存活，
// 若这里也挂 window 监听，切图 Tab 里按 Ctrl+Z 会同时触发画布撤销。
// 因此改为在编辑器根容器上用 React onKeyDown（事件冒泡到根），容器带 tabIndex 并在 pointerdown 时聚焦。
// 与源项目 imagetoslice 的做法一致（layer.tabIndex = -1; layer.focus()）。

import { useCallback, useEffect, useRef } from 'react';

/** 方向键微调步长（像素）。 */
export const NUDGE_STEP = 1;
/** 按住 Shift 时的步长。 */
export const NUDGE_STEP_FAST = 10;

/** 解析出的快捷键动作。 */
export type SliceShortcut =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'delete' }
  /** 移动选中切图 */
  | { kind: 'nudge'; dx: number; dy: number }
  /** 改变选中切图的宽高（Alt + 方向键） */
  | { kind: 'resize'; dw: number; dh: number }
  | { kind: 'selectAll' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'duplicate' }
  | { kind: 'escape' }
  | { kind: 'tool'; tool: 'select' | 'draw' }
  | { kind: 'zoom'; mode: 'fit' | 'actual' }
  | { kind: 'toggleHidden' };

/** 仅取解析所需的字段，便于脱离 DOM 单测。 */
export interface ShortcutEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** 目标是否为可编辑控件（此时多数快捷键应让给浏览器原生行为）。 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 把键盘事件解析为切图动作，返回 null 表示不处理（交给浏览器）。
 *
 * `editing` 为 true 时只放行撤销/重做 —— 与 CanvasEditor 的既有行为保持一致，
 * 其余编辑类快捷键（Delete、方向键、Ctrl+A/C/V/D 等）让给输入框原生行为。
 */
export function resolveSliceShortcut(
  event: ShortcutEventLike,
  options: { editing: boolean },
): SliceShortcut | null {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  // ===== 撤销 / 重做：即使焦点在输入框内也生效 =====
  if (mod && !event.altKey && key === 'z') {
    return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' };
  }
  if (mod && !event.altKey && !event.shiftKey && key === 'y') {
    return { kind: 'redo' };
  }

  // Esc 在输入框内交给输入框自己（取消编辑），不冒泡成"取消选择"
  if (event.key === 'Escape') {
    return options.editing ? null : { kind: 'escape' };
  }

  if (options.editing) return null;

  // ===== 方向键：移动 / 改尺寸 =====
  const step = event.shiftKey ? NUDGE_STEP_FAST : NUDGE_STEP;
  const arrow: Record<string, [number, number]> = {
    arrowleft: [-1, 0],
    arrowright: [1, 0],
    arrowup: [0, -1],
    arrowdown: [0, 1],
  };
  if (arrow[key] && !mod) {
    const [ux, uy] = arrow[key];
    // Alt + 方向键改变宽高，而不是位置
    return event.altKey
      ? { kind: 'resize', dw: ux * step, dh: uy * step }
      : { kind: 'nudge', dx: ux * step, dy: uy * step };
  }

  if (mod && !event.altKey) {
    if (key === 'a') return { kind: 'selectAll' };
    if (key === 'c' && !event.shiftKey) return { kind: 'copy' };
    if (key === 'v' && !event.shiftKey) return { kind: 'paste' };
    if (key === 'd' && !event.shiftKey) return { kind: 'duplicate' };
    return null;
  }

  if (mod || event.altKey) return null;

  // ===== 无修饰键 =====
  if (event.key === 'Delete' || event.key === 'Backspace') return { kind: 'delete' };
  if (key === 'v') return { kind: 'tool', tool: 'select' };
  if (key === 'm') return { kind: 'tool', tool: 'draw' };
  if (key === '0') return { kind: 'zoom', mode: 'fit' };
  if (key === '1') return { kind: 'zoom', mode: 'actual' };
  if (key === 'h') return { kind: 'toggleHidden' };

  return null;
}

export interface SliceKeyboardHandlers {
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onNudge: (dx: number, dy: number) => void;
  onResizeBy: (dw: number, dh: number) => void;
  onSelectAll: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onEscape: () => void;
  onSetTool: (tool: 'select' | 'draw') => void;
  onZoom: (mode: 'fit' | 'actual') => void;
  onToggleHidden: () => void;
  /** 空格按下/松开：用于临时平移 */
  onSpaceChange: (pressed: boolean) => void;
}

/**
 * 返回挂在编辑器根容器上的键盘处理器。
 * 命中快捷键时 preventDefault，避免页面滚动（方向键/空格）与浏览器默认行为（Ctrl+D 收藏等）。
 */
export function useSliceKeyboard(handlers: SliceKeyboardHandlers) {
  // 用 ref 持有最新 handlers，使返回的回调标识稳定（否则每次渲染都会重建）。
  // 必须在 effect 里同步而不是渲染期赋值：渲染期写 ref 违反 React 规则（react-hooks/refs）。
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  }, [handlers]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const editing = isEditableTarget(event.target);

    // 空格：按住临时平移。输入框内不拦截（否则打不出空格）
    if (event.code === 'Space' && !editing) {
      event.preventDefault();
      if (!event.repeat) ref.current.onSpaceChange(true);
      return;
    }

    const shortcut = resolveSliceShortcut(event, { editing });
    if (!shortcut) return;

    const h = ref.current;
    switch (shortcut.kind) {
      case 'undo':
        h.onUndo();
        break;
      case 'redo':
        h.onRedo();
        break;
      case 'delete':
        h.onDelete();
        break;
      case 'nudge':
        h.onNudge(shortcut.dx, shortcut.dy);
        break;
      case 'resize':
        h.onResizeBy(shortcut.dw, shortcut.dh);
        break;
      case 'selectAll':
        h.onSelectAll();
        break;
      case 'copy':
        h.onCopy();
        break;
      case 'paste':
        h.onPaste();
        break;
      case 'duplicate':
        h.onDuplicate();
        break;
      case 'escape':
        h.onEscape();
        break;
      case 'tool':
        h.onSetTool(shortcut.tool);
        break;
      case 'zoom':
        h.onZoom(shortcut.mode);
        break;
      case 'toggleHidden':
        h.onToggleHidden();
        break;
    }
    event.preventDefault();
  }, []);

  const onKeyUp = useCallback((event: React.KeyboardEvent) => {
    if (event.code === 'Space') ref.current.onSpaceChange(false);
  }, []);

  // 容器失焦时松开空格，避免"卡在平移态"
  const onBlur = useCallback(() => {
    ref.current.onSpaceChange(false);
  }, []);

  return { onKeyDown, onKeyUp, onBlur };
}
