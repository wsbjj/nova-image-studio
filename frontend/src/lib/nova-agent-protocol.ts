'use client';

// 多协议 agent 请求协议层：统一消息结构 ⇄ 四种供应商协议的请求体/流式响应。
//
// 与 nova-proxy-text.ts 的分工：
//   nova-proxy-text  —— 单轮「一段文本 + 若干图片」的简单请求（反推、提示词优化、Agent 对话）
//   本文件           —— 多轮带**工具调用**的请求（AI 拆图、网页复刻 agent）
// 两者都经 /api/nova/proxy/text 转发，鉴权与 URL 拼装由后端按协议处理，
// 前端不直连上游（多数上游不给浏览器发 CORS 头）。
//
// 移植自闭源版 ccode-text-protocol.ts，主要差异：
//   1. 协议从 3 种扩到 4 种，补上 google-gemini（含 functionDeclarations 工具形态）
//   2. 不再构造 Authorization 头 —— 凭据随 body 交给后端代理
//   3. 模型不再是固定 ID 表，而是用户在设置里自建的 registry 条目

import { readSseStream } from '@/lib/sse-stream-parser';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';

/** 后端文本代理端点。四种协议共用，由后端按 protocol 决定上游 URL 与鉴权头。 */
export const NOVA_PROXY_TEXT_ENDPOINT = '/api/nova/proxy/text';

export type NovaAgentContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageDataUrl: string; mimeType?: string }
  /** 模型发起的工具调用，回传时原样带回，让模型看到自己上一步做了什么 */
  | { type: 'tool_call'; callId: string; name: string; argumentsJson: string }
  /** 工具执行结果，回传给模型继续推进 */
  | { type: 'tool_result'; callId: string; name: string; output: string };

export interface NovaAgentRequestMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: NovaAgentContentPart[];
}

/** 工具定义。parameters 是标准 JSON Schema。 */
export interface NovaAgentToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface NovaAgentTextStreamResult {
  text: string;
  /** 最后一帧携带的完整响应，供调用方识别 incomplete / max_output_tokens。 */
  finalPayload?: unknown;
  /** 是否收到协议定义的结束帧；连接提前断开时为 false。 */
  complete: boolean;
}

/**
 * 供应商回报的 token 用量。
 * inputTokens 就是「这次喂给模型多少」，即当前上下文大小的权威值——
 * 前端没有 tokenizer，任何字符级估算在中英混排 + 图片输入下都会明显偏差，
 * 所以上下文预算一律以此为准，不做估算。
 */
export interface NovaAgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 命中缓存的输入 token，用于说明重复前缀的实际计费 */
  cachedTokens?: number;
  /** 推理 token，记在输出侧；不会累进下一轮的 inputTokens */
  reasoningTokens?: number;
}

/** 该协议是否会产出可展示的推理摘要。 */
export function supportsReasoningSummary(protocol: TextProviderProtocol): boolean {
  return protocol === 'openai-responses';
}

/** 只含普通内容（文本/图片）的部件，工具部件在各协议里是独立结构 */
type NovaPlainPart = Extract<NovaAgentContentPart, { type: 'text' } | { type: 'image' }>;
type NovaToolCallPart = Extract<NovaAgentContentPart, { type: 'tool_call' }>;
type NovaToolResultPart = Extract<NovaAgentContentPart, { type: 'tool_result' }>;

/** 把一条消息的内容拆成「普通 / 工具调用 / 工具结果」三堆，各协议按各自形状重组 */
function splitParts(parts: NovaAgentContentPart[]): {
  plain: NovaPlainPart[];
  calls: NovaToolCallPart[];
  results: NovaToolResultPart[];
} {
  const plain: NovaPlainPart[] = [];
  const calls: NovaToolCallPart[] = [];
  const results: NovaToolResultPart[] = [];
  for (const part of parts) {
    if (part.type === 'tool_call') calls.push(part);
    else if (part.type === 'tool_result') results.push(part);
    else plain.push(part);
  }
  return { plain, calls, results };
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function parseDataUrl(
  dataUrl: string,
  fallbackMimeType = 'image/png',
): { base64: string; mimeType: string } {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    throw new Error('图片数据格式无效');
  }
  return {
    mimeType: match[1] || fallbackMimeType,
    base64: match[2],
  };
}

// ===== 各协议的 content 形状 =====

function buildResponsesInputContent(parts: NovaPlainPart[]) {
  return parts.map(part => (
    part.type === 'text'
      ? { type: 'input_text' as const, text: part.text }
      : { type: 'input_image' as const, image_url: part.imageDataUrl }
  ));
}

/**
 * assistant 消息在 Responses 协议里的 content 形状。
 *
 * 关键差异：Responses 按「输入/输出」而不是按消息区分内容类型，
 * assistant 角色只接受 output_text / refusal —— 回放历史时若沿用 input_text，
 * 接口直接 400: "Invalid value: 'input_text'"。该路径只在多轮对话里触发，
 * 首轮没有 assistant 历史，所以问题在第二轮才暴露。
 */
function buildResponsesOutputContent(parts: NovaPlainPart[]) {
  return parts
    .filter((part): part is Extract<NovaPlainPart, { type: 'text' }> => part.type === 'text')
    .map(part => ({ type: 'output_text' as const, text: part.text }));
}

function buildChatCompletionsContent(parts: NovaPlainPart[]) {
  return parts.map(part => (
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'image_url' as const, image_url: { url: part.imageDataUrl } }
  ));
}

function buildAnthropicContent(parts: NovaPlainPart[]) {
  return parts.map(part => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text };
    }
    const { base64, mimeType } = parseDataUrl(part.imageDataUrl, part.mimeType);
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mimeType, data: base64 },
    };
  });
}

function buildGeminiParts(parts: NovaPlainPart[]) {
  return parts.map(part => {
    if (part.type === 'text') return { text: part.text };
    const { base64, mimeType } = parseDataUrl(part.imageDataUrl, part.mimeType);
    return { inline_data: { mime_type: mimeType, data: base64 } };
  });
}

// ===== 各协议的消息数组 =====

/**
 * Responses 协议的 input 是一个扁平数组：普通消息是 {role, content}，
 * 而工具调用与工具结果是**顶层条目**，不能包在消息里。所以这里要拍平。
 */
function buildResponsesInput(messages: NovaAgentRequestMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    const { plain, calls, results } = splitParts(message.content);
    if (plain.length > 0) {
      const role = message.role === 'tool' ? 'user' : message.role;
      const content = role === 'assistant'
        ? buildResponsesOutputContent(plain)
        : buildResponsesInputContent(plain);
      // 纯图片的 assistant 消息过滤后可能为空，空 content 同样会被接口拒绝
      if (content.length > 0) items.push({ role, content });
    }
    for (const call of calls) {
      items.push({
        type: 'function_call',
        call_id: call.callId,
        name: call.name,
        arguments: call.argumentsJson,
      });
    }
    for (const result of results) {
      items.push({
        type: 'function_call_output',
        call_id: result.callId,
        output: result.output,
      });
    }
  }
  return items;
}

function buildChatCompletionsMessages(messages: NovaAgentRequestMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    const { plain, calls, results } = splitParts(message.content);
    if (plain.length > 0 || calls.length > 0) {
      items.push({
        role: message.role === 'tool' ? 'assistant' : message.role,
        content: plain.length > 0 ? buildChatCompletionsContent(plain) : null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.callId,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
          : {}),
      });
    }
    for (const result of results) {
      items.push({ role: 'tool', tool_call_id: result.callId, content: result.output });
    }
  }
  return items;
}

function buildAnthropicMessages(messages: NovaAgentRequestMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const { plain, calls, results } = splitParts(message.content);
    if (plain.length > 0 || calls.length > 0) {
      items.push({
        role: message.role === 'tool' ? 'assistant' : message.role,
        content: [
          ...buildAnthropicContent(plain),
          ...calls.map((call) => ({
            type: 'tool_use' as const,
            id: call.callId,
            name: call.name,
            input: parseToolArguments(call.argumentsJson),
          })),
        ],
      });
    }
    // Anthropic 的 tool_result 必须放在 user 消息里
    if (results.length > 0) {
      items.push({
        role: 'user',
        content: results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.callId,
          content: result.output,
        })),
      });
    }
  }
  return items;
}

/**
 * Gemini 的 contents。
 *
 * 两处与其它协议不同：
 *   1. 角色只有 user / model，assistant 与 tool 都要映射过去
 *   2. functionResponse **按 name 匹配**，没有 call id 字段 —— 因此同一轮里
 *      同名工具的多次调用无法区分。网页复刻 agent 的工具是幂等的读/写，
 *      顺序回传即可，不受影响。
 */
function buildGeminiContents(messages: NovaAgentRequestMessage[]): unknown[] {
  const items: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const { plain, calls, results } = splitParts(message.content);

    if (plain.length > 0 || calls.length > 0) {
      items.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [
          ...buildGeminiParts(plain),
          ...calls.map((call) => ({
            functionCall: { name: call.name, args: parseToolArguments(call.argumentsJson) },
          })),
        ],
      });
    }

    if (results.length > 0) {
      items.push({
        role: 'user',
        parts: results.map((result) => ({
          functionResponse: {
            name: result.name,
            // Gemini 要求 response 是对象；工具本身回的是 JSON 字符串，包一层
            response: { result: result.output },
          },
        })),
      });
    }
  }
  return items;
}

// ===== 工具定义的协议形态 =====

/**
 * 把 JSON Schema 收敛成 Gemini 能接受的子集。
 *
 * Gemini 的 functionDeclarations 只认 OpenAPI 3.0 风格的 schema：
 *   - 不支持 `additionalProperties`
 *   - 不支持联合类型（`type: ['integer','null']`）
 * 而工具定义为了 OpenAI strict 模式用了这两者。这里就地转换：
 * 联合类型取第一个非 null 项，并把可空字段从 required 里摘掉
 * （strict 模式要求「全部字段都 required + 可空」，Gemini 反过来要求「可空即非必填」）。
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const nullableKeys = new Set<string>();

  for (const [key, value] of Object.entries(source)) {
    if (key === 'additionalProperties' || key === 'strict') continue;

    if (key === 'type' && Array.isArray(value)) {
      const concrete = value.find((item) => item !== 'null');
      out.type = concrete ?? 'string';
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      const properties: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
        const propType = (propSchema as Record<string, unknown> | null)?.type;
        if (Array.isArray(propType) && propType.includes('null')) {
          nullableKeys.add(propName);
        }
        properties[propName] = toGeminiSchema(propSchema);
      }
      out.properties = properties;
      continue;
    }

    out[key] = toGeminiSchema(value);
  }

  if (Array.isArray(out.required) && nullableKeys.size > 0) {
    out.required = (out.required as unknown[]).filter(
      (name) => typeof name !== 'string' || !nullableKeys.has(name),
    );
  }

  return out;
}

function buildToolsPayload(
  protocol: TextProviderProtocol,
  tools: NovaAgentToolDef[],
): Record<string, unknown> {
  if (tools.length === 0) return {};

  if (protocol === 'openai-chat-completions') {
    return {
      tools: tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      })),
      tool_choice: 'auto',
    };
  }

  if (protocol === 'anthropic-messages') {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    };
  }

  if (protocol === 'google-gemini') {
    return {
      tools: [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiSchema(tool.parameters),
          })),
        },
      ],
    };
  }

  return {
    tools: tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: true,
    })),
    tool_choice: 'auto',
  };
}

/** 思考预算：Gemini 用 token 数，其余协议用 effort 档位。 */
function geminiThinkingBudget(effort: string | undefined): number {
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return -1; // 动态，由模型决定
  if (effort === 'low') return 1024;
  return 4096;
}

/** Responses / Chat 的 effort 只认三档，把更高档位收敛到 high。 */
function clampEffortToThreeLevels(effort: string | undefined): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low';
  if (effort === 'high' || effort === 'xhigh' || effort === 'max') return 'high';
  return 'medium';
}

/**
 * 统一消息结构 → 供应商协议请求体。
 * 切图与网页复刻共用此入口，避免只有某一条协议路径支持图片、工具或输出预算。
 */
export function buildNovaAgentRequestBody(params: {
  protocol: TextProviderProtocol;
  model: string;
  stream: boolean;
  messages: NovaAgentRequestMessage[];
  effort?: string;
  maxOutputTokens?: number;
  tools?: NovaAgentToolDef[];
  /**
   * 开启推理摘要。只对 openai-responses 生效。
   * 不开的话 response.reasoning_summary_text.delta 根本不会产生，
   * 前端就只能在几十秒的推理期里干等——这是"思考中一片空白"的根因。
   */
  reasoningSummary?: boolean;
}): Record<string, unknown> {
  const { protocol, model, stream, messages, effort, maxOutputTokens, reasoningSummary } = params;
  const tools = params.tools ?? [];
  const toolsPayload = buildToolsPayload(protocol, tools);

  if (protocol === 'openai-chat-completions') {
    return {
      model,
      stream,
      ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
      ...toolsPayload,
      messages: buildChatCompletionsMessages(messages),
    };
  }

  if (protocol === 'anthropic-messages') {
    const system = collectSystemText(messages);
    return {
      model,
      stream,
      max_tokens: maxOutputTokens || 4096,
      ...(system ? { system } : {}),
      ...toolsPayload,
      messages: buildAnthropicMessages(messages),
    };
  }

  if (protocol === 'google-gemini') {
    const system = collectSystemText(messages);
    return {
      // 注意：Gemini 的 model 走 URL 而不是 body，由后端代理拼接
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...toolsPayload,
      contents: buildGeminiContents(messages),
      generationConfig: {
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        thinkingConfig: {
          thinkingBudget: geminiThinkingBudget(effort),
          includeThoughts: false,
        },
      },
    };
  }

  return {
    model,
    stream,
    ...(effort
      ? {
          reasoning: {
            effort: clampEffortToThreeLevels(effort),
            ...(reasoningSummary ? { summary: 'detailed' } : {}),
          },
        }
      : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...toolsPayload,
    input: buildResponsesInput(messages),
  };
}

function collectSystemText(messages: NovaAgentRequestMessage[]): string {
  return messages
    .filter((message) => message.role === 'system')
    .flatMap((message) => message.content)
    .filter((part): part is Extract<NovaAgentContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

/**
 * 经后端代理发起一次请求。
 * 凭据与协议随 body 传给代理，由代理决定上游 URL 与鉴权头。
 */
export async function postNovaProxyText(params: {
  protocol: TextProviderProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  stream: boolean;
  requestBody: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  return fetch(NOVA_PROXY_TEXT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(params.stream ? { Accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify({
      protocol: params.protocol,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      stream: params.stream,
      requestBody: params.requestBody,
    }),
    signal: params.signal,
  });
}

/**
 * 读取文本流。优先按 SSE 增量消费；若供应商忽略 stream 并返回 JSON，
 * 自动退回普通响应解析。onDelta 同时给出本次增量和当前完整文本。
 */
export async function readNovaAgentTextStream(
  response: Response,
  protocol: TextProviderProtocol,
  signal: AbortSignal | undefined,
  onDelta?: (delta: string, accumulated: string) => void,
): Promise<NovaAgentTextStreamResult> {
  const readSignal = signal ?? new AbortController().signal;
  const contentType = response.headers.get('content-type') || '';
  if (/application\/(?:json|problem\+json)/i.test(contentType)) {
    const data: unknown = await response.json();
    const text = extractNovaAgentText(protocol, data);
    if (text) onDelta?.(text, text);
    return { text, finalPayload: data, complete: true };
  }
  if (!response.body) {
    throw new Error('响应没有可读流');
  }

  let text = '';
  let finalPayload: unknown;
  let complete = false;
  const append = (delta: string) => {
    if (!delta) return;
    text += delta;
    onDelta?.(delta, text);
  };
  const appendFinalText = (fullText: unknown) => {
    if (typeof fullText !== 'string' || !fullText) return;
    if (!text) {
      append(fullText);
      return;
    }
    if (fullText.startsWith(text) && fullText.length > text.length) {
      append(fullText.slice(text.length));
    }
  };

  await readSseStream(response.body, readSignal, (event) => {
    if (!event.data) return;
    if (event.data === '[DONE]') {
      complete = true;
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    const record = payload as {
      type?: string;
      delta?: string | { text?: string };
      text?: string;
      message?: string | { content?: unknown };
      response?: unknown;
      content_block?: { type?: string; text?: string };
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
      choices?: Array<{
        delta?: { content?: string | Array<{ type?: string; text?: string }> };
        message?: { content?: string | Array<{ type?: string; text?: string }> };
        finish_reason?: string | null;
      }>;
      error?: { message?: string };
    };
    const eventType = record.type || event.event || '';

    if (eventType === 'error' || eventType === 'response.error' || record.error?.message) {
      throw new Error(
        record.error?.message
        || (typeof record.message === 'string' ? record.message : '')
        || '模型返回错误',
      );
    }

    if (protocol === 'openai-chat-completions') {
      const choice = record.choices?.[0];
      const content = choice?.delta?.content ?? choice?.message?.content;
      append(flattenTextContent(content));
      if (choice?.message?.content !== undefined) finalPayload = payload;
      if (choice?.finish_reason) complete = true;
      return;
    }

    if (protocol === 'anthropic-messages') {
      if (
        eventType === 'content_block_start'
        && record.content_block?.type === 'text'
        && typeof record.content_block.text === 'string'
      ) {
        append(record.content_block.text);
      } else if (
        eventType === 'content_block_delta'
        && record.delta
        && typeof record.delta === 'object'
        && typeof record.delta.text === 'string'
      ) {
        append(record.delta.text);
      }
      if (eventType === 'message_stop') {
        finalPayload = payload;
        complete = true;
      }
      return;
    }

    if (protocol === 'google-gemini') {
      if (record.promptFeedback?.blockReason) {
        throw new Error(`内容被拦截: ${record.promptFeedback.blockReason}`);
      }
      for (const candidate of record.candidates || []) {
        for (const part of candidate.content?.parts || []) {
          if (part.thought === true) continue;
          if (typeof part.text === 'string') append(part.text);
        }
        if (candidate.finishReason) {
          finalPayload = payload;
          complete = true;
        }
      }
      return;
    }

    if (eventType === 'response.output_text.delta') {
      append(typeof record.delta === 'string' ? record.delta : '');
      return;
    }
    if (eventType === 'response.output_text.done') {
      appendFinalText(record.text);
      return;
    }
    if (eventType === 'response.completed' || eventType === 'response.incomplete') {
      finalPayload = record.response || payload;
      complete = true;
      appendFinalText(extractNovaAgentText('openai-responses', record.response));
    }
  });

  return { text, finalPayload, complete };
}

function flattenTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** 提取供应商明确报告的输出上限/不完整原因。 */
export function getNovaAgentIncompleteReason(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as {
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
    choices?: Array<{ finish_reason?: unknown }>;
    candidates?: Array<{ finishReason?: unknown }>;
    delta?: { stop_reason?: unknown };
    stop_reason?: unknown;
  };
  if (record.status === 'incomplete') {
    const reason = record.incomplete_details?.reason;
    return typeof reason === 'string' && reason ? reason : 'incomplete';
  }
  if (record.choices?.[0]?.finish_reason === 'length') return 'max_output_tokens';
  if (record.candidates?.[0]?.finishReason === 'MAX_TOKENS') return 'max_output_tokens';
  if (record.delta?.stop_reason === 'max_tokens' || record.stop_reason === 'max_tokens') {
    return 'max_output_tokens';
  }
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 提取供应商回报的 token 用量。四种协议字段名不同（responses 用 input_tokens、
 * chat-completions 用 prompt_tokens、messages 用 input_tokens + cache_read_input_tokens、
 * gemini 用 usageMetadata.promptTokenCount），这里按字段名逐个回退，
 * 因此不需要知道当前协议。
 *
 * 拿不到 input/output 任一项就返回 null：上下文计数宁可保持上一次的值，
 * 也不要用 0 覆盖真实用量，造成"用量突然归零"的错觉。
 */
export function getNovaAgentUsage(data: unknown): NovaAgentUsage | null {
  if (!data || typeof data !== 'object') return null;

  const root = data as {
    usage?: unknown;
    response?: { usage?: unknown };
    usageMetadata?: unknown;
  };

  // Gemini 走独立字段名
  const geminiUsage = root.usageMetadata as
    | {
        promptTokenCount?: unknown;
        candidatesTokenCount?: unknown;
        totalTokenCount?: unknown;
        cachedContentTokenCount?: unknown;
        thoughtsTokenCount?: unknown;
      }
    | undefined;
  if (geminiUsage && typeof geminiUsage === 'object') {
    const inputTokens = toFiniteNumber(geminiUsage.promptTokenCount);
    const outputTokens = toFiniteNumber(geminiUsage.candidatesTokenCount);
    if (inputTokens === null || outputTokens === null) return null;
    const usage: NovaAgentUsage = {
      inputTokens,
      outputTokens,
      totalTokens: toFiniteNumber(geminiUsage.totalTokenCount) ?? inputTokens + outputTokens,
    };
    const cached = toFiniteNumber(geminiUsage.cachedContentTokenCount);
    const reasoning = toFiniteNumber(geminiUsage.thoughtsTokenCount);
    if (cached !== null) usage.cachedTokens = cached;
    if (reasoning !== null) usage.reasoningTokens = reasoning;
    return usage;
  }

  // responses 流的最后一帧可能是 { type, response: { usage } }，也可能已被解包
  const rawUsage = (root.usage ?? root.response?.usage) as
    | {
        input_tokens?: unknown;
        output_tokens?: unknown;
        total_tokens?: unknown;
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        cache_read_input_tokens?: unknown;
        input_tokens_details?: { cached_tokens?: unknown } | null;
        output_tokens_details?: { reasoning_tokens?: unknown } | null;
      }
    | undefined;
  if (!rawUsage || typeof rawUsage !== 'object') return null;

  const inputTokens =
    toFiniteNumber(rawUsage.input_tokens) ?? toFiniteNumber(rawUsage.prompt_tokens);
  const outputTokens =
    toFiniteNumber(rawUsage.output_tokens) ?? toFiniteNumber(rawUsage.completion_tokens);
  if (inputTokens === null || outputTokens === null) return null;

  const cachedTokens =
    toFiniteNumber(rawUsage.input_tokens_details?.cached_tokens)
    ?? toFiniteNumber(rawUsage.cache_read_input_tokens);
  const reasoningTokens = toFiniteNumber(rawUsage.output_tokens_details?.reasoning_tokens);

  const usage: NovaAgentUsage = {
    inputTokens,
    outputTokens,
    totalTokens: toFiniteNumber(rawUsage.total_tokens) ?? inputTokens + outputTokens,
  };
  if (cachedTokens !== null) usage.cachedTokens = cachedTokens;
  if (reasoningTokens !== null) usage.reasoningTokens = reasoningTokens;
  return usage;
}

export function extractNovaAgentText(protocol: TextProviderProtocol, data: unknown): string {
  if (!data || typeof data !== 'object') return '';

  if (protocol === 'openai-chat-completions') {
    const record = data as {
      choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    };
    return flattenTextContent(record.choices?.[0]?.message?.content);
  }

  if (protocol === 'anthropic-messages') {
    const record = data as { content?: Array<{ type?: string; text?: string }> };
    return (record.content || [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  if (protocol === 'google-gemini') {
    const record = data as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    };
    return (record.candidates || [])
      .flatMap((candidate) => candidate.content?.parts || [])
      .filter((part) => part.thought !== true && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }

  const record = data as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof record.output_text === 'string') return record.output_text;
  return (record.output || [])
    .flatMap((item) => item.content || [])
    .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}
