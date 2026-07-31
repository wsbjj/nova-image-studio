import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types";
import { getGenerationResourceNodes } from "../canvas-resource-references";

function node(id: string, type: CanvasNodeType, metadata: CanvasNodeData["metadata"] = {}): CanvasNodeData {
  return { id, type, title: id, metadata, position: { x: 0, y: 0 }, width: 240, height: 160 };
}

function edge(id: string, fromNodeId: string, toNodeId: string): CanvasConnection {
  return { id, fromNodeId, toNodeId };
}

describe("getGenerationResourceNodes", () => {
  it("walks upstream resources and stops at the previous config boundary", () => {
    const nodes = [
      node("original", CanvasNodeType.Image, { content: "data:image/png;base64,original" }),
      node("previous-config", CanvasNodeType.Config),
      node("generated", CanvasNodeType.Image, { content: "data:image/png;base64,generated" }),
      node("instruction", CanvasNodeType.Text, { content: "修改天空" }),
      node("current-config", CanvasNodeType.Config),
    ];
    const connections = [
      edge("original-previous", "original", "previous-config"),
      edge("previous-generated", "previous-config", "generated"),
      edge("generated-instruction", "generated", "instruction"),
      edge("instruction-current", "instruction", "current-config"),
    ];

    expect(getGenerationResourceNodes("current-config", nodes, connections).map((item) => item.id)).toEqual([
      "generated",
      "instruction",
    ]);
  });
});
