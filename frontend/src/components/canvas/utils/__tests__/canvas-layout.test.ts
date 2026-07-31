import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types";
import { arrangeCanvasNodes, layoutCanvasGraph } from "../canvas-layout";

function node(id: string, x: number, y: number, width = 100, height = 80): CanvasNodeData {
  return { id, type: CanvasNodeType.Text, title: id, position: { x, y }, width, height, metadata: {} };
}

describe("canvas layout", () => {
  it("aligns selected nodes to the first selected node without moving other nodes", () => {
    const nodes = [node("anchor", 120, 40), node("second", 360, 180), node("other", 700, 240)];

    const result = arrangeCanvasNodes(nodes, ["anchor", "second"], "align-left");

    expect(result.find((item) => item.id === "anchor")?.position.x).toBe(120);
    expect(result.find((item) => item.id === "second")?.position.x).toBe(120);
    expect(result.find((item) => item.id === "other")?.position).toEqual({ x: 700, y: 240 });
  });

  it("distributes three nodes with equal horizontal gaps while keeping the outer nodes fixed", () => {
    const nodes = [node("left", 0, 0, 100), node("middle", 170, 80, 80), node("right", 400, 20, 100)];

    const result = arrangeCanvasNodes(nodes, ["left", "middle", "right"], "distribute-horizontal");

    const left = result.find((item) => item.id === "left")!;
    const middle = result.find((item) => item.id === "middle")!;
    const right = result.find((item) => item.id === "right")!;
    expect(left.position.x).toBe(0);
    expect(right.position.x).toBe(400);
    expect(middle.position.x - (left.position.x + left.width)).toBe(110);
    expect(right.position.x - (middle.position.x + middle.width)).toBe(110);
  });

  it("lays out a connected generation chain from left to right without moving isolated nodes", () => {
    const nodes = [
      node("core", 200, 200),
      node("city", 20, 500),
      { ...node("config", 80, 40, 180, 140), type: CanvasNodeType.Config },
      { ...node("result", 500, 400, 160, 160), type: CanvasNodeType.Image },
      node("isolated", 900, 900),
    ];
    const connections: CanvasConnection[] = [
      { id: "core-city", fromNodeId: "core", toNodeId: "city" },
      { id: "city-config", fromNodeId: "city", toNodeId: "config" },
      { id: "config-result", fromNodeId: "config", toNodeId: "result" },
    ];

    const result = layoutCanvasGraph(nodes, connections, ["core", "city", "config", "result"]);
    const x = (id: string) => result.find((item) => item.id === id)!.position.x;

    expect(x("core")).toBeLessThan(x("city"));
    expect(x("city")).toBeLessThan(x("config"));
    expect(x("config")).toBeLessThan(x("result"));
    expect(result.find((item) => item.id === "isolated")?.position).toEqual({ x: 900, y: 900 });
  });
});
