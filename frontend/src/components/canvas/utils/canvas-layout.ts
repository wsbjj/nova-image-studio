import dagre from "@dagrejs/dagre";

import type { CanvasConnection, CanvasNodeData } from "../types";

export type CanvasArrangeMode =
  | "align-left"
  | "align-center-horizontal"
  | "align-right"
  | "align-top"
  | "align-center-vertical"
  | "align-bottom"
  | "distribute-horizontal"
  | "distribute-vertical"
  | "row"
  | "column"
  | "grid";

const ARRANGE_GAP = 32;

export function arrangeCanvasNodes(nodes: CanvasNodeData[], selectedIds: string[], mode: CanvasArrangeMode) {
  const selectedSet = new Set(selectedIds);
  const selected = selectedIds.map((id) => nodes.find((node) => node.id === id)).filter((node): node is CanvasNodeData => Boolean(node));
  if (selected.length < 2) return nodes;

  const positions = new Map(selected.map((node) => [node.id, { ...node.position }]));
  const anchor = selected[0];

  if (mode === "align-left") selected.forEach((node) => positions.set(node.id, { ...node.position, x: anchor.position.x }));
  if (mode === "align-center-horizontal") {
    const center = anchor.position.x + anchor.width / 2;
    selected.forEach((node) => positions.set(node.id, { ...node.position, x: center - node.width / 2 }));
  }
  if (mode === "align-right") {
    const right = anchor.position.x + anchor.width;
    selected.forEach((node) => positions.set(node.id, { ...node.position, x: right - node.width }));
  }
  if (mode === "align-top") selected.forEach((node) => positions.set(node.id, { ...node.position, y: anchor.position.y }));
  if (mode === "align-center-vertical") {
    const center = anchor.position.y + anchor.height / 2;
    selected.forEach((node) => positions.set(node.id, { ...node.position, y: center - node.height / 2 }));
  }
  if (mode === "align-bottom") {
    const bottom = anchor.position.y + anchor.height;
    selected.forEach((node) => positions.set(node.id, { ...node.position, y: bottom - node.height }));
  }
  if (mode === "distribute-horizontal" && selected.length >= 3) distribute(selected, positions, "horizontal");
  if (mode === "distribute-vertical" && selected.length >= 3) distribute(selected, positions, "vertical");
  if (mode === "row") placeSequence(selected, positions, "horizontal");
  if (mode === "column") placeSequence(selected, positions, "vertical");
  if (mode === "grid") placeGrid(selected, positions);

  return nodes.map((node) => selectedSet.has(node.id) ? { ...node, position: positions.get(node.id) ?? node.position } : node);
}

export function layoutCanvasGraph(nodes: CanvasNodeData[], connections: CanvasConnection[], targetIds: string[]) {
  const targetSet = new Set(targetIds);
  const targets = nodes.filter((node) => targetSet.has(node.id));
  if (targets.length < 2) return nodes;

  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", ranksep: 96, nodesep: 48, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  targets.forEach((node) => graph.setNode(node.id, { width: node.width, height: node.height }));
  connections.forEach((connection) => {
    if (targetSet.has(connection.fromNodeId) && targetSet.has(connection.toNodeId)) {
      graph.setEdge(connection.fromNodeId, connection.toNodeId);
    }
  });
  dagre.layout(graph);

  const raw = targets.map((node) => {
    const position = graph.node(node.id) as { x: number; y: number };
    return { node, x: position.x - node.width / 2, y: position.y - node.height / 2 };
  });
  const originalMinX = Math.min(...targets.map((node) => node.position.x));
  const originalMinY = Math.min(...targets.map((node) => node.position.y));
  const rawMinX = Math.min(...raw.map((item) => item.x));
  const rawMinY = Math.min(...raw.map((item) => item.y));
  const positions = new Map(raw.map(({ node, x, y }) => [node.id, { x: x - rawMinX + originalMinX, y: y - rawMinY + originalMinY }]));

  return nodes.map((node) => targetSet.has(node.id) ? { ...node, position: positions.get(node.id) ?? node.position } : node);
}

function distribute(nodes: CanvasNodeData[], positions: Map<string, CanvasNodeData["position"]>, axis: "horizontal" | "vertical") {
  const sorted = [...nodes].sort((a, b) => axis === "horizontal" ? a.position.x - b.position.x : a.position.y - b.position.y);
  const start = axis === "horizontal" ? sorted[0].position.x : sorted[0].position.y;
  const last = sorted[sorted.length - 1];
  const end = axis === "horizontal" ? last.position.x + last.width : last.position.y + last.height;
  const totalSize = sorted.reduce((sum, node) => sum + (axis === "horizontal" ? node.width : node.height), 0);
  const gap = (end - start - totalSize) / (sorted.length - 1);
  let cursor = start;
  sorted.forEach((node) => {
    positions.set(node.id, axis === "horizontal" ? { ...node.position, x: cursor } : { ...node.position, y: cursor });
    cursor += (axis === "horizontal" ? node.width : node.height) + gap;
  });
}

function placeSequence(nodes: CanvasNodeData[], positions: Map<string, CanvasNodeData["position"]>, axis: "horizontal" | "vertical") {
  let cursor = axis === "horizontal" ? nodes[0].position.x : nodes[0].position.y;
  nodes.forEach((node) => {
    positions.set(node.id, axis === "horizontal" ? { x: cursor, y: nodes[0].position.y } : { x: nodes[0].position.x, y: cursor });
    cursor += (axis === "horizontal" ? node.width : node.height) + ARRANGE_GAP;
  });
}

function placeGrid(nodes: CanvasNodeData[], positions: Map<string, CanvasNodeData["position"]>) {
  const columns = Math.ceil(Math.sqrt(nodes.length));
  const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(...nodes.filter((_, index) => index % columns === column).map((node) => node.width)));
  const rows = Math.ceil(nodes.length / columns);
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(...nodes.slice(row * columns, (row + 1) * columns).map((node) => node.height)));
  const start = nodes[0].position;
  nodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = start.x + columnWidths.slice(0, column).reduce((sum, width) => sum + width + ARRANGE_GAP, 0);
    const y = start.y + rowHeights.slice(0, row).reduce((sum, height) => sum + height + ARRANGE_GAP, 0);
    positions.set(node.id, { x, y });
  });
}
