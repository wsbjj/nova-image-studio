import { describe, expect, it } from "vitest";

import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../../types";
import {
  enumeratePromptRoutes,
  findSelectedPromptRoute,
  isInvalidPromptRouteSelection,
  MAX_PROMPT_ROUTES,
  promptRouteId,
} from "../canvas-prompt-routes";

function textNode(id: string, title: string): CanvasNodeData {
  return {
    id,
    title,
    type: CanvasNodeType.Text,
    position: { x: 0, y: 0 },
    width: 240,
    height: 160,
    metadata: { content: title },
  };
}

function configNode(id: string): CanvasNodeData {
  return {
    id,
    title: id,
    type: CanvasNodeType.Config,
    position: { x: 0, y: 0 },
    width: 320,
    height: 240,
  };
}

function connection(id: string, fromNodeId: string, toNodeId: string): CanvasConnection {
  return { id, fromNodeId, toNodeId };
}

describe("canvas prompt routes", () => {
  it("enumerates every ordered text path into a config", () => {
    const nodes = [textNode("core", "核心提示词"), textNode("concept", "城市创意"), textNode("beijing", "北京专属"), configNode("config-1")];
    const connections = [
      connection("core-concept", "core", "concept"),
      connection("concept-beijing", "concept", "beijing"),
      connection("core-beijing", "core", "beijing"),
      connection("beijing-config-1", "beijing", "config-1"),
    ];

    const result = enumeratePromptRoutes("config-1", nodes, connections);

    expect(result.truncated).toBe(false);
    expect(result.routes.map((route) => route.connectionIds)).toEqual([
      ["core-concept", "concept-beijing", "beijing-config-1"],
      ["core-beijing", "beijing-config-1"],
    ]);
    expect(result.routes.map((route) => route.label)).toEqual([
      "核心提示词 -> 城市创意 -> 北京专属",
      "核心提示词 -> 北京专属",
    ]);
  });

  it("does not emit a route whose only upstream continuation is cyclic", () => {
    const nodes = [textNode("a", "A"), textNode("b", "B"), configNode("config")];
    const connections = [connection("a-b", "a", "b"), connection("b-a", "b", "a"), connection("b-config", "b", "config")];

    expect(enumeratePromptRoutes("config", nodes, connections).routes).toEqual([]);
  });

  it("suffixes duplicate labels without changing route identity", () => {
    const nodes = [textNode("a", "城市专属"), textNode("b", "城市专属"), configNode("config")];
    const connections = [connection("a-config", "a", "config"), connection("b-config", "b", "config")];

    const routes = enumeratePromptRoutes("config", nodes, connections).routes;

    expect(routes.map((route) => route.label)).toEqual(["城市专属", "城市专属 (2)"]);
    expect(routes.map((route) => route.id)).toEqual([promptRouteId(["a-config"]), promptRouteId(["b-config"])]);
  });

  it("caps dense graphs and reports truncation", () => {
    const roots = Array.from({ length: MAX_PROMPT_ROUTES + 1 }, (_, index) => textNode(`root-${index}`, `路线 ${index}`));
    const nodes = [...roots, configNode("config")];
    const connections = roots.map((node, index) => connection(`route-${index}`, node.id, "config"));

    const result = enumeratePromptRoutes("config", nodes, connections);

    expect(result.routes).toHaveLength(MAX_PROMPT_ROUTES);
    expect(result.truncated).toBe(true);
  });

  it("resolves valid selections and rejects stale ones", () => {
    const nodes = [textNode("source", "来源"), configNode("config")];
    const connections = [connection("source-config", "source", "config")];
    const routes = enumeratePromptRoutes("config", nodes, connections).routes;

    expect(findSelectedPromptRoute({ mode: "route", connectionIds: ["source-config"] }, routes)?.id).toBe(promptRouteId(["source-config"]));
    expect(isInvalidPromptRouteSelection({ mode: "route", connectionIds: ["missing"] }, routes)).toBe(true);
    expect(isInvalidPromptRouteSelection({ mode: "manual" }, routes)).toBe(false);
    expect(isInvalidPromptRouteSelection(undefined, routes)).toBe(false);
  });
});
