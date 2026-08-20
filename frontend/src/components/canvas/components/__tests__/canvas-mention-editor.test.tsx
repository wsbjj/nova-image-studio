import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasMentionEditor } from "../canvas-mention-editor";
import type { CanvasResourceReference } from "../../utils/canvas-resource-references";

const references: CanvasResourceReference[] = [
  {
    id: "image-1",
    nodeId: "image-1",
    kind: "image",
    label: "图片1",
    title: "第一张图片",
    active: true,
  },
  {
    id: "image-2",
    nodeId: "image-2",
    kind: "image",
    label: "图片2",
    title: "第二张图片",
    active: true,
  },
];

function setCaretToEnd(element: HTMLElement) {
  const textNode = element.firstChild;
  if (!textNode) throw new Error("Expected editor text node");
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(textNode, textNode.textContent?.length ?? 0);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("CanvasMentionEditor", () => {
  beforeEach(() => {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => document.body.getBoundingClientRect(),
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });

  it("keeps the ArrowDown selection after keyup and inserts the second reference", () => {
    const onChange = vi.fn();
    render(<CanvasMentionEditor value="@" references={references} onChange={onChange} />);

    const editor = screen.getByRole("textbox");
    setCaretToEnd(editor);
    fireEvent.keyUp(editor, { key: "@" });

    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyUp(editor, { key: "ArrowDown" });

    expect(screen.getByRole("button", { name: /图片2/ })).toHaveClass("bg-muted");

    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("@[node:image-2]"));
  });
});
