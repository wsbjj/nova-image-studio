"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { FileText, Image as ImageIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CanvasResourceReference } from "../utils/canvas-resource-references";

type MentionState = { query: string; rect: DOMRect };

type Props = {
  value: string;
  references: CanvasResourceReference[];
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
};

const CHIP_CLASS =
  "mx-0.5 inline-flex items-center gap-0.5 rounded-md bg-primary/15 px-1.5 py-0.5 align-baseline text-[11px] font-medium text-primary ring-1 ring-primary/25";
const CHIP_REMOVE_CLASS = "grid size-3.5 place-items-center rounded-sm text-primary/70 transition-colors hover:bg-primary/25 hover:text-primary";
const TOKEN_REGEX = /@\[node:([^\]]+)\]/g;
const MENTION_TRIGGER = /(^|[\s\u00a0])@([^\s@\u00a0]*)$/;

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textToHtml(value: string) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function chipHtml(id: string, label: string) {
  return `<span data-mention-id="${escapeHtml(id)}" contenteditable="false" class="${CHIP_CLASS}"><span data-mention-label>${escapeHtml(label)}</span><button type="button" data-mention-remove="${escapeHtml(id)}" class="${CHIP_REMOVE_CLASS}">×</button></span>`;
}

/** value(含 @[node:id] token) → 编辑器 innerHTML（token 渲染为带 label 的 chip）。 */
function valueToHtml(value: string, labelByNodeId: Map<string, string>) {
  let html = "";
  let lastIndex = 0;
  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_REGEX.exec(value))) {
    html += textToHtml(value.slice(lastIndex, match.index));
    const id = match[1];
    html += chipHtml(id, labelByNodeId.get(id) || "已失效");
    lastIndex = match.index + match[0].length;
  }
  html += textToHtml(value.slice(lastIndex));
  return html;
}

function serializeNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as HTMLElement;
  if (el.dataset.mentionId) return `@[node:${el.dataset.mentionId}]`;
  if (el.tagName === "BR") return "\n";
  let inner = "";
  el.childNodes.forEach((child) => {
    inner += serializeNode(child);
  });
  return el.tagName === "DIV" || el.tagName === "P" ? `\n${inner}` : inner;
}

/** 编辑器 DOM → value(含 token) */
function serializeEditor(root: HTMLElement): string {
  let out = "";
  root.childNodes.forEach((node) => {
    out += serializeNode(node);
  });
  return out;
}

function createChip(id: string, label: string) {
  const span = document.createElement("span");
  span.dataset.mentionId = id;
  span.contentEditable = "false";
  span.className = CHIP_CLASS;
  const labelEl = document.createElement("span");
  labelEl.dataset.mentionLabel = "";
  labelEl.textContent = label;
  const removeEl = document.createElement("button");
  removeEl.type = "button";
  removeEl.dataset.mentionRemove = id;
  removeEl.className = CHIP_REMOVE_CLASS;
  removeEl.textContent = "×";
  span.append(labelEl, removeEl);
  return span;
}

function deepestTextNode(node: ChildNode | null, fromEnd: boolean): Text | null {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  const children = node.childNodes;
  for (let index = fromEnd ? children.length - 1 : 0; fromEnd ? index >= 0 : index < children.length; fromEnd ? index-- : index++) {
    const found = deepestTextNode(children[index], fromEnd);
    if (found) return found;
  }
  return null;
}

function getTextInputContext(root: HTMLElement): { textNode: Text; offset: number } | null {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  if (!root.contains(container)) return null;
  if (container.nodeType === Node.TEXT_NODE) {
    return { textNode: container as Text, offset: range.startOffset };
  }
  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  const element = container as Element;
  const before = range.startOffset > 0 ? element.childNodes[range.startOffset - 1] : null;
  const after = element.childNodes[range.startOffset] ?? null;
  const previousText = deepestTextNode(before, true);
  if (previousText) return { textNode: previousText, offset: previousText.data.length };
  const nextText = deepestTextNode(after, false);
  if (nextText) return { textNode: nextText, offset: 0 };
  return null;
}

/**
 * 编排节点的 @ 提及编辑器：contentEditable + 原子 chip（带 ✕，退格整体删除），无 overlay 故无光标错位。
 * value 以 @[node:<id>] token 存储，与 buildComposerGenerationContext 解析一致。
 */
export function CanvasMentionEditor({ value, references, onChange, onSubmit, placeholder, className }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastValueRef = useRef<string>("__canvas_init__");
  const labelByNodeIdRef = useRef<Map<string, string>>(new Map());
  const mentionQueryRef = useRef<string | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const labelByNodeId = useMemo(() => new Map(references.map((item) => [item.nodeId, item.label])), [references]);
  const activeReferences = useMemo(() => references.filter((item) => item.active), [references]);
  const candidates = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.trim().toLowerCase();
    if (!query) return activeReferences;
    return activeReferences.filter((item) => `${item.label} ${item.title} ${item.kind} ${item.text || ""}`.toLowerCase().includes(query));
  }, [mention, activeReferences]);

  useEffect(() => {
    labelByNodeIdRef.current = labelByNodeId;
  }, [labelByNodeId]);

  // 外部 value 变化（初始化 / 切换 / 程序化清空）时重建 DOM；用户输入不在此重建（避免光标跳动）。
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    if (value === lastValueRef.current) return;
    el.innerHTML = valueToHtml(value, labelByNodeIdRef.current);
    lastValueRef.current = value;
  }, [value]);

  // references 变化时，仅就地更新已存在 chip 的 label 文本（不动光标）。
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>("[data-mention-id]").forEach((span) => {
      const id = span.dataset.mentionId;
      if (!id) return;
      const labelEl = span.querySelector<HTMLElement>("[data-mention-label]");
      const label = labelByNodeId.get(id) || "已失效";
      if (labelEl && labelEl.textContent !== label) labelEl.textContent = label;
    });
  }, [labelByNodeId]);

  const closeMention = useCallback(() => {
    mentionQueryRef.current = null;
    setMention(null);
    setActiveIndex(0);
  }, []);

  const emitChange = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const next = serializeEditor(el);
    lastValueRef.current = next;
    onChange(next);
  }, [onChange]);

  const refreshMention = useCallback(() => {
    const el = editorRef.current;
    if (!el) {
      closeMention();
      return;
    }
    const context = getTextInputContext(el);
    if (!context) {
      closeMention();
      return;
    }
    const textBefore = context.textNode.data.slice(0, context.offset);
    const match = MENTION_TRIGGER.exec(textBefore);
    if (!match || !activeReferences.length) {
      closeMention();
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      closeMention();
      return;
    }
    const range = selection.getRangeAt(0).cloneRange();
    let rect = range.getBoundingClientRect();
    if (!rect || (rect.x === 0 && rect.y === 0 && rect.width === 0 && rect.height === 0)) rect = el.getBoundingClientRect();
    const query = match[2];
    if (mentionQueryRef.current !== query) {
      mentionQueryRef.current = query;
      setActiveIndex(0);
    }
    setMention({ query, rect });
  }, [activeReferences.length, closeMention]);

  const insertReference = useCallback(
    (reference: CanvasResourceReference) => {
      const el = editorRef.current;
      const selection = window.getSelection();
      if (!el || !selection || selection.rangeCount === 0) return;
      const context = getTextInputContext(el);
      if (!context) return;
      const { textNode, offset } = context;
      const match = MENTION_TRIGGER.exec(textNode.data.slice(0, offset));
      if (!match) return;
      const atIndex = offset - match[2].length - 1;
      textNode.deleteData(atIndex, match[2].length + 1);
      const tail = textNode.splitText(atIndex);
      const chip = createChip(reference.nodeId, reference.label);
      const spacer = document.createTextNode(" ");
      tail.parentNode?.insertBefore(chip, tail);
      tail.parentNode?.insertBefore(spacer, tail);
      const newRange = document.createRange();
      newRange.setStart(spacer, spacer.length);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
      closeMention();
      emitChange();
    },
    [closeMention, emitChange],
  );

  const removeChip = useCallback(
    (id: string) => {
      const el = editorRef.current;
      if (!el) return;
      el.querySelector<HTMLElement>(`[data-mention-id="${CSS.escape(id)}"]`)?.remove();
      emitChange();
      el.focus();
    },
    [emitChange],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (mention && candidates.length) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % candidates.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((index) => (index - 1 + candidates.length) % candidates.length);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          insertReference(candidates[Math.min(activeIndex, candidates.length - 1)]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeMention();
          return;
        }
      }

      if (event.key === "Enter" && onSubmit && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        onSubmit();
        return;
      }

      // 退格兜底：光标紧邻 chip 时整体删除（多数浏览器对 contenteditable=false 原生即整体删除）。
      if (event.key === "Backspace") {
        const selection = window.getSelection();
        if (selection && selection.isCollapsed && selection.rangeCount > 0) {
          const range = selection.getRangeAt(0);
          const node = range.startContainer;
          let chip: HTMLElement | null = null;
          if (node.nodeType === Node.TEXT_NODE && range.startOffset === 0) {
            const prev = node.previousSibling as HTMLElement | null;
            if (prev?.dataset?.mentionId) chip = prev;
          } else if (node === editorRef.current && range.startOffset > 0) {
            const prev = editorRef.current.childNodes[range.startOffset - 1] as HTMLElement | null;
            if (prev?.dataset?.mentionId) chip = prev;
          }
          if (chip) {
            event.preventDefault();
            chip.remove();
            emitChange();
            return;
          }
        }
      }
    },
    [activeIndex, candidates, closeMention, emitChange, insertReference, mention, onSubmit],
  );

  return (
    <div className="relative h-full w-full" data-canvas-no-zoom>
      {!value && <div className="pointer-events-none absolute inset-0 select-none text-muted-foreground">{placeholder}</div>}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        spellCheck={false}
        className={cn("h-full w-full cursor-text whitespace-pre-wrap break-words outline-none", className)}
        onInput={() => {
          emitChange();
          refreshMention();
        }}
        onKeyUp={refreshMention}
        onMouseUp={refreshMention}
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          const target = (event.target as HTMLElement).closest("[data-mention-remove]") as HTMLElement | null;
          if (target?.dataset.mentionRemove) {
            event.preventDefault();
            removeChip(target.dataset.mentionRemove);
          }
        }}
        onBlur={() => window.setTimeout(closeMention, 120)}
      />
      {mention && candidates.length > 0 && <MentionMenu rect={mention.rect} references={candidates} activeIndex={Math.min(activeIndex, candidates.length - 1)} onSelect={insertReference} />}
    </div>
  );
}

function MentionMenu({ rect, references, activeIndex, onSelect }: { rect: DOMRect; references: CanvasResourceReference[]; activeIndex: number; onSelect: (reference: CanvasResourceReference) => void }) {
  const menuWidth = 256;
  const maxMenuHeight = 224;
  const gap = 6;
  const boundary = { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 };
  const left = clamp(rect.left, boundary.left, boundary.right - menuWidth);
  const showAbove = rect.bottom + gap + maxMenuHeight > boundary.bottom && rect.top - gap - maxMenuHeight >= boundary.top;
  const top = clamp(showAbove ? rect.top - gap - maxMenuHeight : rect.bottom + gap, boundary.top, boundary.bottom - maxMenuHeight);

  return createPortal(
    <div
      data-canvas-no-zoom
      className="fixed z-[140] max-h-56 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-2xl"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {references.map((reference, index) => (
        <button
          key={reference.id}
          type="button"
          className={cn("flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors", index === activeIndex ? "bg-muted" : "hover:bg-muted/60")}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(reference);
          }}
        >
          <ReferencePreview reference={reference} />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{reference.label}</span>
            <span className="block truncate text-muted-foreground">{reference.text || reference.title}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}

function ReferencePreview({ reference }: { reference: CanvasResourceReference }) {
  if (reference.kind === "image" && reference.previewUrl) return <img src={reference.previewUrl} alt="" className="size-9 rounded-md object-cover" />;
  const Icon = reference.kind === "image" ? ImageIcon : FileText;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
      <Icon className="size-4" />
    </span>
  );
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}
