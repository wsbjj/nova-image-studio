import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildNacosModelRegistryContent,
  createNacosModelRegistryFetchPayload,
  fetchNacosModelRegistryConfig,
  normalizeNacosServerUrl,
} from '@/lib/remote-config-client';
import type { NovaModelRegistry } from '@/lib/nova-models';

const registry: NovaModelRegistry = {
  imageModels: [
    {
      id: 'image-banana-pro',
      protocol: 'google',
      name: 'Banana Pro',
      modelId: 'gemini-3-pro-image-preview',
      apiKey: 'sk-image-key',
      baseUrl: 'https://nn.147ai.com',
      builtinPreset: 'gemini-3-pro-image-preview',
      maxRefImages: 11,
      maxOutputSize: '4K',
      supportsAdvancedParams: false,
    },
  ],
  textModels: [
    {
      id: 'text-gpt-5-5',
      protocol: 'openai',
      name: 'gpt-5.5',
      modelId: 'gpt-5.5',
      apiKey: 'sk-text-key',
      baseUrl: 'https://cmdme.cn',
      note: 'OpenAI Response',
    },
  ],
  defaults: {
    textToImage: 'image-banana-pro',
    imageToImage: 'image-banana-pro',
    reversePrompt: 'text-gpt-5-5',
    agent: 'text-gpt-5-5',
    promptOptimize: 'text-gpt-5-5',
    imageDescribe: 'text-gpt-5-5',
  },
};

describe('remote Nacos config client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes a domain, IP, or Nacos console URL to the API origin', () => {
    expect(normalizeNacosServerUrl('192.168.8.110:8080')).toBe('http://192.168.8.110:8080');
    expect(normalizeNacosServerUrl('http://192.168.8.110:8080/next/#/configurationManagement')).toBe('http://192.168.8.110:8080');
    expect(normalizeNacosServerUrl('https://nacos.example.com/nacos')).toBe('https://nacos.example.com');
  });

  it('serializes every model and default field shown in settings', () => {
    const content = buildNacosModelRegistryContent(registry, new Date('2026-07-02T00:00:00.000Z'));
    const parsed = JSON.parse(content);

    expect(parsed).toMatchObject({
      schema: 'nova-image-studio.model-registry.v1',
      exportedAt: '2026-07-02T00:00:00.000Z',
      imageModels: [
        {
          id: 'image-banana-pro',
          protocol: 'google',
          name: 'Banana Pro',
          modelId: 'gemini-3-pro-image-preview',
          apiKey: 'sk-image-key',
          baseUrl: 'https://nn.147ai.com',
          builtinPreset: 'gemini-3-pro-image-preview',
          maxRefImages: 11,
          maxOutputSize: '4K',
          supportsAdvancedParams: false,
        },
      ],
      textModels: [
        {
          id: 'text-gpt-5-5',
          protocol: 'openai',
          name: 'gpt-5.5',
          modelId: 'gpt-5.5',
          apiKey: 'sk-text-key',
          baseUrl: 'https://cmdme.cn',
          note: 'OpenAI Response',
        },
      ],
      defaults: registry.defaults,
    });
  });

  it('builds a Nacos fetch payload compatible with the console list', () => {
    const payload = createNacosModelRegistryFetchPayload({
      serverUrl: '192.168.8.110:8080',
      namespaceId: '',
      groupName: '',
      dataId: '',
      username: ' nacos ',
      password: ' nacos ',
    });

    expect(payload.serverUrl).toBe('http://192.168.8.110:8080');
    expect(payload.namespaceId).toBe('public');
    expect(payload.groupName).toBe('DEFAULT_GROUP');
    expect(payload.dataId).toBe('nova-image-studio-model-registry.json');
    expect(payload.username).toBe('nacos');
    expect(payload.password).toBe('nacos');
  });

  it('fetches and parses the model registry through the local backend proxy', async () => {
    const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      content: buildNacosModelRegistryContent(registry, new Date('2026-07-02T00:00:00.000Z')),
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const fetched = await fetchNacosModelRegistryConfig({
      serverUrl: 'http://192.168.8.110:8080/next/#/configurationManagement',
      namespaceId: 'public',
      groupName: 'REMOTE_GROUP',
      dataId: 'models.json',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/nova/remote-config/nacos/fetch', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      serverUrl: 'http://192.168.8.110:8080',
      namespaceId: 'public',
      groupName: 'REMOTE_GROUP',
      dataId: 'models.json',
    });
    expect(fetched.imageModels[0].maxRefImages).toBe(11);
    expect(fetched.textModels[0].baseUrl).toBe('https://cmdme.cn');
    expect(fetched.defaults.agent).toBe('text-gpt-5-5');
  });

  it('rejects remote content that is not a model registry JSON object', async () => {
    const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, content: '{"hello":"world"}' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchNacosModelRegistryConfig({ serverUrl: '192.168.8.110:8080' }))
      .rejects.toThrow('Nacos 配置内容不是有效的模型配置');
  });
});
