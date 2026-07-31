import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types";
import { duplicateCanvasSelection } from "../canvas-clipboard";

const nodes: CanvasNodeData[] = [
  { id: "a", type: CanvasNodeType.Text, title: "A", position: { x: 10, y: 20 }, width: 100, height: 80, metadata: { content: "A" } },
  { id: "b", type: CanvasNodeType.Config, title: "B", position: { x: 200, y: 20 }, width: 180, height: 120, metadata: { composerContent: "B" } },
  { id: "outside", type: CanvasNodeType.Text, title: "Outside", position: { x: 500, y: 20 }, width: 100, height: 80, metadata: {} },
];
const connections: CanvasConnection[] = [
  { id: "a-b", fromNodeId: "a", toNodeId: "b" },
  { id: "b-outside", fromNodeId: "b", toNodeId: "outside" },
];

describe("canvas clipboard", () => {
  it("duplicates selected nodes and only the connections internal to that selection", () => {
    const ids = ["clone-a", "clone-b", "clone-connection"];

    const result = duplicateCanvasSelection(nodes, connections, ["a", "b"], () => ids.shift()!, 40);

    expect(result.nodes.map((node) => node.id)).toEqual(["clone-a", "clone-b"]);
    expect(result.nodes.map((node) => node.position)).toEqual([{ x: 50, y: 60 }, { x: 240, y: 60 }]);
    expect(result.connections).toEqual([
      { id: "clone-connection", fromNodeId: "clone-a", toNodeId: "clone-b" },
    ]);
  });
});
