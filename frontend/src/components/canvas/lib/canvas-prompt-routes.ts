import {
  CanvasNodeType,
  type CanvasConnection,
  type CanvasNodeData,
  type CanvasPromptRouteSelection,
} from "../types";

export const MANUAL_PROMPT_ROUTE_VALUE = "manual";
export const MAX_PROMPT_ROUTES = 100;

export type CanvasPromptRoute = {
  id: string;
  label: string;
  nodeIds: string[];
  connectionIds: string[];
};

export type PromptRouteEnumeration = {
  routes: CanvasPromptRoute[];
  truncated: boolean;
};

export function promptRouteId(connectionIds: string[]) {
  return `route:${connectionIds.join("|")}`;
}

export function enumeratePromptRoutes(
  configNodeId: string,
  nodes: CanvasNodeData[],
  connections: CanvasConnection[],
  limit = MAX_PROMPT_ROUTES,
): PromptRouteEnumeration {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  if (nodeById.get(configNodeId)?.type !== CanvasNodeType.Config || limit <= 0) {
    return { routes: [], truncated: false };
  }

  const incoming = new Map<string, CanvasConnection[]>();
  for (const connection of connections) {
    const from = nodeById.get(connection.fromNodeId);
    const to = nodeById.get(connection.toNodeId);
    const eligible = from?.type === CanvasNodeType.Text &&
      (to?.type === CanvasNodeType.Text || to?.type === CanvasNodeType.Config);
    if (!eligible) continue;
    incoming.set(connection.toNodeId, [...(incoming.get(connection.toNodeId) ?? []), connection]);
  }

  const rawRoutes: Omit<CanvasPromptRoute, "label">[] = [];
  let truncated = false;

  const walkTextNode = (
    nodeId: string,
    reverseNodeIds: string[],
    reverseConnectionIds: string[],
    visited: Set<string>,
  ) => {
    if (truncated) return;
    const incomingConnections = incoming.get(nodeId) ?? [];
    if (incomingConnections.length === 0) {
      if (rawRoutes.length >= limit) {
        truncated = true;
        return;
      }
      const nodeIds = [...reverseNodeIds].reverse();
      const connectionIds = [...reverseConnectionIds].reverse();
      rawRoutes.push({ id: promptRouteId(connectionIds), nodeIds, connectionIds });
      return;
    }

    for (const connection of incomingConnections) {
      if (visited.has(connection.fromNodeId)) continue;
      const nextVisited = new Set(visited);
      nextVisited.add(connection.fromNodeId);
      walkTextNode(
        connection.fromNodeId,
        [...reverseNodeIds, connection.fromNodeId],
        [...reverseConnectionIds, connection.id],
        nextVisited,
      );
      if (truncated) return;
    }
  };

  for (const connection of incoming.get(configNodeId) ?? []) {
    walkTextNode(
      connection.fromNodeId,
      [connection.fromNodeId],
      [connection.id],
      new Set([configNodeId, connection.fromNodeId]),
    );
    if (truncated) break;
  }

  const labelCounts = new Map<string, number>();
  const routes = rawRoutes.map((route) => {
    const baseLabel = route.nodeIds
      .map((nodeId) => nodeById.get(nodeId)?.title.trim() || nodeId)
      .join(" -> ");
    const occurrence = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, occurrence);
    return { ...route, label: occurrence === 1 ? baseLabel : `${baseLabel} (${occurrence})` };
  });

  return { routes, truncated };
}

export function findSelectedPromptRoute(
  selection: CanvasPromptRouteSelection | undefined,
  routes: CanvasPromptRoute[],
) {
  if (selection?.mode !== "route") return null;
  const id = promptRouteId(selection.connectionIds);
  return routes.find((route) => route.id === id) ?? null;
}

export function isInvalidPromptRouteSelection(
  selection: CanvasPromptRouteSelection | undefined,
  routes: CanvasPromptRoute[],
) {
  return selection?.mode === "route" && !findSelectedPromptRoute(selection, routes);
}
