'use client';

import { DEFAULT_DEFAULTS, type NovaModelRegistry } from '@/lib/nova-models';

export interface NacosRemoteConfigTarget {
  serverUrl: string;
  namespaceId?: string;
  groupName?: string;
  dataId?: string;
  username?: string;
  password?: string;
}

export interface NacosModelRegistryFetchPayload {
  serverUrl: string;
  namespaceId: string;
  groupName: string;
  dataId: string;
  username?: string;
  password?: string;
}

export interface NacosFetchResult {
  ok: boolean;
  serverUrl?: string;
  namespaceId?: string;
  groupName?: string;
  dataId?: string;
  content?: unknown;
  registry?: unknown;
  message?: string;
}

export const DEFAULT_NACOS_NAMESPACE_ID = 'public';
export const DEFAULT_NACOS_GROUP_NAME = 'DEFAULT_GROUP';
export const DEFAULT_NACOS_DATA_ID = 'nova-image-studio-model-registry.json';

function trimOptional(value: string | undefined): string {
  return String(value || '').trim();
}

export function normalizeNacosServerUrl(input: string): string {
  const trimmed = trimOptional(input).replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('请填写 Nacos 域名或 IP');
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('protocol');
    }
    return url.origin;
  } catch {
    throw new Error('Nacos 地址格式无效，请填写域名、IP 或完整控制台地址');
  }
}

export function buildNacosModelRegistryContent(
  registry: NovaModelRegistry,
  exportedAt: Date = new Date(),
): string {
  return JSON.stringify({
    schema: 'nova-image-studio.model-registry.v1',
    exportedAt: exportedAt.toISOString(),
    imageModels: registry.imageModels,
    textModels: registry.textModels,
    defaults: registry.defaults,
  }, null, 2);
}

export function createNacosModelRegistryFetchPayload(
  target: NacosRemoteConfigTarget,
): NacosModelRegistryFetchPayload {
  const username = trimOptional(target.username);
  const password = trimOptional(target.password);
  const payload: NacosModelRegistryFetchPayload = {
    serverUrl: normalizeNacosServerUrl(target.serverUrl),
    namespaceId: trimOptional(target.namespaceId) || DEFAULT_NACOS_NAMESPACE_ID,
    groupName: trimOptional(target.groupName) || DEFAULT_NACOS_GROUP_NAME,
    dataId: trimOptional(target.dataId) || DEFAULT_NACOS_DATA_ID,
  };

  if (username) payload.username = username;
  if (password) payload.password = password;

  return payload;
}

async function readRemoteConfigError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return `远程配置获取失败: ${response.status}`;

  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const message = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.message === 'string'
        ? parsed.message
        : '';
    return message || `远程配置获取失败: ${response.status}`;
  } catch {
    return text.slice(0, 200);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseModelRegistryContent(content: unknown): NovaModelRegistry {
  let parsed: unknown = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error('Nacos 配置内容不是有效 JSON');
    }
  }

  if (!isRecord(parsed)
    || !Array.isArray(parsed.imageModels)
    || !Array.isArray(parsed.textModels)
    || !isRecord(parsed.defaults)) {
    throw new Error('Nacos 配置内容不是有效的模型配置');
  }

  return {
    imageModels: parsed.imageModels as NovaModelRegistry['imageModels'],
    textModels: parsed.textModels as NovaModelRegistry['textModels'],
    defaults: {
      ...DEFAULT_DEFAULTS,
      ...(parsed.defaults as Partial<NovaModelRegistry['defaults']>),
    },
  };
}

export async function fetchNacosModelRegistryConfig(
  target: NacosRemoteConfigTarget,
): Promise<NovaModelRegistry> {
  const payload = createNacosModelRegistryFetchPayload(target);
  const response = await fetch('/api/nova/remote-config/nacos/fetch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(await readRemoteConfigError(response));
  }

  const result = await response.json().catch(() => null) as NacosFetchResult | null;
  if (!result || result.ok === false) {
    throw new Error(result?.message || '远程配置获取失败');
  }

  return parseModelRegistryContent(result.registry || result.content);
}
