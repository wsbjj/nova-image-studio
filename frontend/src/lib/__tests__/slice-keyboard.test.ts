import { describe, expect, it } from 'vitest';

import {
  NUDGE_STEP,
  NUDGE_STEP_FAST,
  isEditableTarget,
  resolveSliceShortcut,
  type ShortcutEventLike,
} from '@/components/slice/use-slice-keyboard';

function ev(key: string, mods: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

const editing = { editing: true };
const idle = { editing: false };

describe('undo / redo', () => {
  it('maps Ctrl+Z and Cmd+Z to undo', () => {
    expect(resolveSliceShortcut(ev('z', { ctrlKey: true }), idle)).toEqual({ kind: 'undo' });
    expect(resolveSliceShortcut(ev('Z', { metaKey: true }), idle)).toEqual({ kind: 'undo' });
  });

  it('maps Ctrl+Shift+Z and Ctrl+Y to redo', () => {
    expect(resolveSliceShortcut(ev('z', { ctrlKey: true, shiftKey: true }), idle)).toEqual({ kind: 'redo' });
    expect(resolveSliceShortcut(ev('y', { ctrlKey: true }), idle)).toEqual({ kind: 'redo' });
  });

  it('still works while typing in an input', () => {
    // 撤销/重做是唯一允许在输入框内穿透的编辑类快捷键，与 CanvasEditor 行为一致
    expect(resolveSliceShortcut(ev('z', { ctrlKey: true }), editing)).toEqual({ kind: 'undo' });
    expect(resolveSliceShortcut(ev('y', { ctrlKey: true }), editing)).toEqual({ kind: 'redo' });
  });

  it('ignores Alt+Ctrl+Z', () => {
    expect(resolveSliceShortcut(ev('z', { ctrlKey: true, altKey: true }), idle)).toBeNull();
  });
});

describe('delete', () => {
  it('maps Delete and Backspace', () => {
    expect(resolveSliceShortcut(ev('Delete'), idle)).toEqual({ kind: 'delete' });
    expect(resolveSliceShortcut(ev('Backspace'), idle)).toEqual({ kind: 'delete' });
  });

  it('does not fire while typing', () => {
    // 否则在重命名输入框里退格会把切图删掉
    expect(resolveSliceShortcut(ev('Delete'), editing)).toBeNull();
    expect(resolveSliceShortcut(ev('Backspace'), editing)).toBeNull();
  });
});

describe('arrow keys', () => {
  it('nudges by 1px', () => {
    expect(resolveSliceShortcut(ev('ArrowLeft'), idle)).toEqual({ kind: 'nudge', dx: -NUDGE_STEP, dy: 0 });
    expect(resolveSliceShortcut(ev('ArrowRight'), idle)).toEqual({ kind: 'nudge', dx: NUDGE_STEP, dy: 0 });
    expect(resolveSliceShortcut(ev('ArrowUp'), idle)).toEqual({ kind: 'nudge', dx: 0, dy: -NUDGE_STEP });
    expect(resolveSliceShortcut(ev('ArrowDown'), idle)).toEqual({ kind: 'nudge', dx: 0, dy: NUDGE_STEP });
  });

  it('nudges by 10px with Shift', () => {
    expect(resolveSliceShortcut(ev('ArrowRight', { shiftKey: true }), idle)).toEqual({
      kind: 'nudge',
      dx: NUDGE_STEP_FAST,
      dy: 0,
    });
  });

  it('resizes with Alt instead of moving', () => {
    expect(resolveSliceShortcut(ev('ArrowRight', { altKey: true }), idle)).toEqual({
      kind: 'resize',
      dw: NUDGE_STEP,
      dh: 0,
    });
    expect(resolveSliceShortcut(ev('ArrowDown', { altKey: true, shiftKey: true }), idle)).toEqual({
      kind: 'resize',
      dw: 0,
      dh: NUDGE_STEP_FAST,
    });
  });

  it('leaves arrows alone while typing and when combined with Ctrl', () => {
    expect(resolveSliceShortcut(ev('ArrowLeft'), editing)).toBeNull();
    // Ctrl+方向键留给浏览器/系统（按词移动等）
    expect(resolveSliceShortcut(ev('ArrowLeft', { ctrlKey: true }), idle)).toBeNull();
  });
});

describe('clipboard and selection', () => {
  it('maps select-all, copy, paste, duplicate', () => {
    expect(resolveSliceShortcut(ev('a', { ctrlKey: true }), idle)).toEqual({ kind: 'selectAll' });
    expect(resolveSliceShortcut(ev('c', { ctrlKey: true }), idle)).toEqual({ kind: 'copy' });
    expect(resolveSliceShortcut(ev('v', { ctrlKey: true }), idle)).toEqual({ kind: 'paste' });
    expect(resolveSliceShortcut(ev('d', { ctrlKey: true }), idle)).toEqual({ kind: 'duplicate' });
  });

  it('does not hijack these while typing', () => {
    // 输入框里的 Ctrl+A/C/V 必须是原生全选/复制/粘贴
    for (const key of ['a', 'c', 'v', 'd']) {
      expect(resolveSliceShortcut(ev(key, { ctrlKey: true }), editing)).toBeNull();
    }
  });

  it('ignores Ctrl+Shift variants', () => {
    expect(resolveSliceShortcut(ev('c', { ctrlKey: true, shiftKey: true }), idle)).toBeNull();
    expect(resolveSliceShortcut(ev('v', { ctrlKey: true, shiftKey: true }), idle)).toBeNull();
  });
});

describe('bare keys', () => {
  it('maps tool, zoom, hide, escape', () => {
    expect(resolveSliceShortcut(ev('v'), idle)).toEqual({ kind: 'tool', tool: 'select' });
    expect(resolveSliceShortcut(ev('m'), idle)).toEqual({ kind: 'tool', tool: 'draw' });
    expect(resolveSliceShortcut(ev('0'), idle)).toEqual({ kind: 'zoom', mode: 'fit' });
    expect(resolveSliceShortcut(ev('1'), idle)).toEqual({ kind: 'zoom', mode: 'actual' });
    expect(resolveSliceShortcut(ev('h'), idle)).toEqual({ kind: 'toggleHidden' });
    expect(resolveSliceShortcut(ev('Escape'), idle)).toEqual({ kind: 'escape' });
  });

  it('never fires bare letters while typing', () => {
    // 关键：在名称输入框里打 "v"/"m"/"h" 不能切工具或隐藏切图
    for (const key of ['v', 'm', 'h', '0', '1']) {
      expect(resolveSliceShortcut(ev(key), editing)).toBeNull();
    }
    // Esc 在输入框内交给输入框自己取消编辑
    expect(resolveSliceShortcut(ev('Escape'), editing)).toBeNull();
  });

  it('ignores unmapped keys', () => {
    expect(resolveSliceShortcut(ev('q'), idle)).toBeNull();
    expect(resolveSliceShortcut(ev('Tab'), idle)).toBeNull();
    expect(resolveSliceShortcut(ev('F5'), idle)).toBeNull();
  });
});

describe('isEditableTarget', () => {
  it('detects form controls and contenteditable', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    expect(isEditableTarget(document.createElement('select'))).toBe(true);

    const div = document.createElement('div');
    expect(isEditableTarget(div)).toBe(false);
    // jsdom 不根据属性推导 isContentEditable，直接打桩验证分支
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isEditableTarget(div)).toBe(true);
  });

  it('handles null and non-elements', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document.createElement('button'))).toBe(false);
  });
});
