import type { CanvasConnection, CanvasNodeData } from "../types";

export function duplicateCanvasSelection(
  nodes: CanvasNodeData[],
  connections: CanvasConnection[],
  selectedIds: string[],
  createId: () => string,
  offset = 40,
) {
  const selectedSet = new Set(selectedIds);
  const idMap = new Map<string, string>();
  const clonedNodes = nodes.filter((node) => selectedSet.has(node.id)).map((node) => {
    const id = createId();
    idMap.set(node.id, id);
    return {
      ...node,
      id,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      metadata: cloneMetadata(node.metadata),
    };
  });
  const clonedConnections = connections
    .filter((connection) => selectedSet.has(connection.fromNodeId) && selectedSet.has(connection.toNodeId))
    .map((connection) => ({
      id: createId(),
      fromNodeId: idMap.get(connection.fromNodeId)!,
      toNodeId: idMap.get(connection.toNodeId)!,
    }));
  return { nodes: clonedNodes, connections: clonedConnections };
}

function cloneMetadata(metadata: CanvasNodeData["metadata"]): CanvasNodeData["metadata"] {
  if (!metadata) return undefined;
  return {
    ...metadata,
    genConfig: metadata.genConfig ? { ...metadata.genConfig } : undefined,
    promptRouteSelection: metadata.promptRouteSelection?.mode === "route"
      ? { mode: "route", connectionIds: [...metadata.promptRouteSelection.connectionIds] }
      : metadata.promptRouteSelection,
    references: metadata.references ? [...metadata.references] : undefined,
    batchChildIds: metadata.batchChildIds ? [...metadata.batchChildIds] : undefined,
  };
}
