import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CanvasEditor } from "../CanvasEditor";
import { useCanvasStore, type CanvasProject } from "../stores/use-canvas-store";
import { CanvasNodeType } from "../types";

const project: CanvasProject = {
  id: "project-1",
  title: "Connection deletion",
  createdAt: "2026-07-27T00:00:00.000Z",
  updatedAt: "2026-07-27T00:00:00.000Z",
  nodes: [
    {
      id: "node-a",
      type: CanvasNodeType.Text,
      title: "A",
      position: { x: 0, y: 0 },
      width: 240,
      height: 160,
      metadata: { content: "A" },
    },
    {
      id: "node-b",
      type: CanvasNodeType.Text,
      title: "B",
      position: { x: 420, y: 0 },
      width: 240,
      height: 160,
      metadata: { content: "B" },
    },
  ],
  connections: [{ id: "connection-1", fromNodeId: "node-a", toNodeId: "node-b" }],
  backgroundMode: "lines",
  showImageInfo: false,
  viewport: { x: 0, y: 0, k: 1 },
};

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe("CanvasEditor connections", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    useCanvasStore.setState({ hydrated: true, projects: [project] });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function renderEditor() {
    return render(
      <CanvasEditor
        projectId={project.id}
        onBack={() => undefined}
        onRequireApiKey={() => undefined}
        showToast={() => undefined}
      />,
    );
  }

  it("deletes the selected connection with the Delete key", async () => {
    const { container } = renderEditor();

    const connection = container.querySelector<SVGPathElement>('[data-connection-id="connection-1"]');
    expect(connection).not.toBeNull();

    fireEvent.click(connection!);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.connections).toHaveLength(0);
    });
  });

  it("deletes the selected connection from the toolbar", async () => {
    const { container } = renderEditor();
    const connection = container.querySelector<SVGPathElement>('[data-connection-id="connection-1"]');
    expect(connection).not.toBeNull();

    fireEvent.click(connection!);
    fireEvent.click(screen.getByRole("button", { name: "删除选中" }));

    await waitFor(() => {
      expect(useCanvasStore.getState().openProject(project.id)?.connections).toHaveLength(0);
    });
  });

  it("copies the connections internal to a multi-node selection", async () => {
    const { container } = renderEditor();
    const nodeA = container.querySelector<HTMLElement>('[data-node-id="node-a"]')!;
    const nodeB = container.querySelector<HTMLElement>('[data-node-id="node-b"]')!;

    fireEvent.pointerDown(nodeA, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(nodeB, { button: 0, ctrlKey: true, clientX: 440, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });
    fireEvent.keyDown(window, { key: "v", ctrlKey: true });

    await waitFor(() => {
      const saved = useCanvasStore.getState().openProject(project.id)!;
      expect(saved.nodes).toHaveLength(4);
      expect(saved.connections).toHaveLength(2);
      const clonedIds = saved.nodes.filter((node) => node.id !== "node-a" && node.id !== "node-b").map((node) => node.id);
      expect(saved.connections.some((connection) => clonedIds.includes(connection.fromNodeId) && clonedIds.includes(connection.toNodeId))).toBe(true);
    });
  });

  it("prevents the system clipboard from also pasting when duplicating copied nodes", async () => {
    const { container } = renderEditor();
    const nodeA = container.querySelector<HTMLElement>('[data-node-id="node-a"]')!;
    fireEvent.pointerDown(nodeA, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(window, { key: "c", ctrlKey: true });

    const pasteShortcut = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(fireEvent(window, pasteShortcut)).toBe(false);
    await waitFor(() => {
      const saved = useCanvasStore.getState().openProject(project.id)!;
      expect(saved.nodes).toHaveLength(3);
      expect(saved.nodes.map((node) => node.metadata?.content)).toEqual(["A", "B", "A"]);
    });
  });

  it("allows system clipboard paste when no canvas nodes were copied", () => {
    renderEditor();
    const pasteShortcut = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });

    expect(fireEvent(window, pasteShortcut)).toBe(true);
  });

  it("aligns selected nodes from the arrange menu", async () => {
    const { container } = renderEditor();
    const nodeA = container.querySelector<HTMLElement>('[data-node-id="node-a"]')!;
    const nodeB = container.querySelector<HTMLElement>('[data-node-id="node-b"]')!;
    fireEvent.pointerDown(nodeA, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(nodeB, { button: 0, ctrlKey: true, clientX: 440, clientY: 20 });
    fireEvent.pointerUp(window);

    fireEvent.click(screen.getByRole("button", { name: "排列节点" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "左对齐" }));

    await waitFor(() => {
      const saved = useCanvasStore.getState().openProject(project.id)!;
      expect(saved.nodes.find((node) => node.id === "node-a")?.position.x).toBe(0);
      expect(saved.nodes.find((node) => node.id === "node-b")?.position.x).toBe(0);
    });
  });

  it("creates a node at the right-clicked canvas position", async () => {
    const { container } = renderEditor();
    const canvas = container.querySelector<HTMLElement>("[data-canvas-mode]")!;

    fireEvent.contextMenu(canvas, { clientX: 300, clientY: 260 });
    fireEvent.click(await screen.findByRole("button", { name: "在此添加文本节点" }));

    await waitFor(() => {
      const saved = useCanvasStore.getState().openProject(project.id)!;
      expect(saved.nodes).toHaveLength(3);
      const createdNode = saved.nodes[2];
      expect({
        x: createdNode.position.x + createdNode.width / 2,
        y: createdNode.position.y + createdNode.height / 2,
      }).toEqual({ x: 300, y: 260 });
    });
  });

  it("box-selects nodes by default when dragging the blank canvas", async () => {
    const { container } = renderEditor();
    const canvas = container.querySelector<HTMLElement>("[data-canvas-mode]")!;

    expect(screen.getByRole("button", { name: "选择模式" })).toHaveAttribute("data-pressed");
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 700, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    await waitFor(() => {
      expect(container.querySelector('[data-node-id="node-a"]')).toHaveAttribute("data-selected", "true");
      expect(container.querySelector('[data-node-id="node-b"]')).toHaveAttribute("data-selected", "true");
    });
  });

  it("toggles nodes inside a modifier-assisted box selection", async () => {
    const { container } = renderEditor();
    const nodeA = container.querySelector<HTMLElement>('[data-node-id="node-a"]')!;
    const canvas = container.querySelector<HTMLElement>("[data-canvas-mode]")!;
    fireEvent.pointerDown(nodeA, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window);

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 4, shiftKey: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 700, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 4 });

    await waitFor(() => {
      expect(container.querySelector('[data-node-id="node-a"]')).not.toHaveAttribute("data-selected");
      expect(container.querySelector('[data-node-id="node-b"]')).toHaveAttribute("data-selected", "true");
    });
  });

  it("pans the blank canvas after switching to hand mode", async () => {
    const { container } = renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "抓手模式" }));
    const canvas = container.querySelector<HTMLElement>('[data-canvas-mode="pan"]')!;

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 700, clientY: 400 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 750, clientY: 450 });
    fireEvent.pointerUp(window, { pointerId: 2 });

    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".origin-top-left")).toHaveStyle("transform: translate(50px, 50px) scale(1)");
    });
  });

  it("temporarily pans with Space while selection mode stays active", async () => {
    const { container } = renderEditor();
    const canvas = container.querySelector<HTMLElement>("[data-canvas-mode]")!;

    fireEvent.keyDown(window, { code: "Space" });
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 700, clientY: 400 });
    fireEvent.pointerMove(window, { pointerId: 3, clientX: 730, clientY: 420 });
    fireEvent.pointerUp(window, { pointerId: 3 });
    fireEvent.keyUp(window, { code: "Space" });

    await waitFor(() => {
      expect(container.querySelector<HTMLElement>(".origin-top-left")).toHaveStyle("transform: translate(30px, 20px) scale(1)");
      expect(screen.getByRole("button", { name: "选择模式" })).toHaveAttribute("data-pressed");
    });
  });
});
