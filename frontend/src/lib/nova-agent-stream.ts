'use client';

// 支持工具调用与推理摘要的流式读取。
//
// 为什么不直接扩展 readNovaAgentTextStream：那个函数的契约是「只抽正文」，
// 被切图拆解等多处复用。往里塞工具累加器会让每个调用方都背上不需要的分支。
// 这里独立一份，专供 agent 循环。
//
// 三类事件分开处理：
//   生命周期  response.created / in_progress / keepalive → 驱动阶段文案
//   思考      response.reasoning_summary_* → 推理摘要，填补首个 token 前的空白期
//   输出      output_text / function_call_arguments → 正文与工具参数
//
// 移植自闭源版 ccode-agent-stream.ts，补上 google-gemini 分支。

import {
  extractNovaAgentText,
  getNovaAgentUsage,
  type NovaAgentUsage,
} from '@/lib/nova-agent-protocol';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';
import { readSseStream } from '@/lib/sse-stream-parser';

export interface NovaToolCallDraft {
  callId: string;
  name: string;
  argumentsJson: string;
}

export type NovaAgentPhase = 'created' | 'in_progress' | 'reasoning' | 'responding' | 'completed';

export interface NovaAgentStreamHandlers {
  /**
   * 每收到一帧就调用一次，**包括 keepalive**。
   * keepalive 的唯一作用就是证明连接还活着，用它喂空闲超时计时器，
   * 长推理才不会被当成静默连接误杀。
   */
  onActivity?: () => void;
  onPhase?: (phase: NovaAgentPhase) => void;
  onReasoningDelta?: (delta: string, accumulated: string) => void;
  onText?: (delta: string, accumulated: string) => void;
  onToolCallStart?: (call: { callId: string; name: string }) => void;
  onToolArgsDelta?: (call: NovaToolCallDraft) => void;
}

export interface NovaAgentStreamResult {
  text: string;
  reasoning: string;
  toolCalls: NovaToolCallDraft[];
  usage: NovaAgentUsage | null;
  finalPayload?: unknown;
  complete: boolean;
}

interface MutableDraft extends NovaToolCallDraft {
  /** 供应商给的条目标识，用来把后续 delta 归到正确的调用上 */
  key: string;
}

export async function readNovaAgentStream(
  response: Response,
  protocol: TextProviderProtocol,
  signal: AbortSignal | undefined,
  handlers: NovaAgentStreamHandlers = {},
): Promise<NovaAgentStreamResult> {
  const readSignal = signal ?? new AbortController().signal;

  let text = '';
  let reasoning = '';
  let usage: NovaAgentUsage | null = null;
  let finalPayload: unknown;
  let complete = false;
  let lastPhase: NovaAgentPhase | null = null;
  /** Gemini 的 functionCall 没有 id，用「本轮内第几个」合成键 */
  let geminiCallSeq = 0;

  // 用 Map 保序，且天然支持并行工具调用（同一轮里多个 call 各自累加参数）
  const drafts = new Map<string, MutableDraft>();

  const setPhase = (phase: NovaAgentPhase) => {
    if (lastPhase === phase) return;
    lastPhase = phase;
    handlers.onPhase?.(phase);
  };
  const appendText = (delta: string) => {
    if (!delta) return;
    text += delta;
    handlers.onText?.(delta, text);
    setPhase('responding');
  };
  const appendReasoning = (delta: string) => {
    if (!delta) return;
    reasoning += delta;
    handlers.onReasoningDelta?.(delta, reasoning);
    setPhase('reasoning');
  };
  const ensureDraft = (key: string, callId: string, name: string): MutableDraft => {
    const existing = drafts.get(key);
    if (existing) {
      if (callId) existing.callId = callId;
      if (name) existing.name = name;
      return existing;
    }
    const draft: MutableDraft = { key, callId: callId || key, name, argumentsJson: '' };
    drafts.set(key, draft);
    handlers.onToolCallStart?.({ callId: draft.callId, name: draft.name });
    setPhase('responding');
    return draft;
  };

  // 非流式回退：部分供应商会忽略 stream:true 直接返回 JSON
  const contentType = response.headers.get('content-type') || '';
  if (/application\/(?:json|problem\+json)/i.test(contentType)) {
    const data: unknown = await response.json();
    const fullText = extractNovaAgentText(protocol, data);
    if (fullText) appendText(fullText);
    for (const call of collectToolCallsFromPayload(protocol, data)) {
      const draft = ensureDraft(call.callId, call.callId, call.name);
      draft.argumentsJson = call.argumentsJson;
    }
    setPhase('completed');
    return {
      text,
      reasoning,
      toolCalls: [...drafts.values()].map(toPublicDraft),
      usage: getNovaAgentUsage(data),
      finalPayload: data,
      complete: true,
    };
  }

  if (!response.body) throw new Error('响应没有可读流');

  await readSseStream(response.body, readSignal, (event) => {
    handlers.onActivity?.();

    if (!event.data) return;
    if (event.data === '[DONE]') {
      complete = true;
      setPhase('completed');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    const record = payload as StreamRecord;
    const eventType = record.type || event.event || '';

    if (eventType === 'error' || eventType === 'response.error' || record.error?.message) {
      throw new Error(
        record.error?.message
          || (typeof record.message === 'string' ? record.message : '')
          || '模型返回错误',
      );
    }

    // keepalive 只喂计时器，不产生任何内容
    if (eventType === 'keepalive' || eventType === 'ping') return;

    if (protocol === 'openai-chat-completions') {
      handleChatCompletions(record, payload);
      return;
    }
    if (protocol === 'anthropic-messages') {
      handleAnthropic(record, payload);
      return;
    }
    if (protocol === 'google-gemini') {
      handleGemini(record, payload);
      return;
    }
    handleResponses(record, payload);
  });

  return {
    text,
    reasoning,
    toolCalls: [...drafts.values()].map(toPublicDraft),
    usage,
    finalPayload,
    complete,
  };

  // ===== 各协议事件处理 =====

  function handleResponses(record: StreamRecord, payload: unknown) {
    const eventType = record.type || '';

    if (eventType === 'response.created') {
      setPhase('created');
      return;
    }
    if (eventType === 'response.in_progress') {
      setPhase('in_progress');
      return;
    }

    if (eventType === 'response.reasoning_summary_part.added') {
      // 多段摘要之间补空行，避免在面板里粘成一坨
      if (reasoning) appendReasoning('\n\n');
      else setPhase('reasoning');
      return;
    }
    if (eventType === 'response.reasoning_summary_text.delta') {
      appendReasoning(typeof record.delta === 'string' ? record.delta : '');
      return;
    }

    if (eventType === 'response.output_text.delta') {
      appendText(typeof record.delta === 'string' ? record.delta : '');
      return;
    }
    if (eventType === 'response.output_text.done') {
      appendFinalText(typeof record.text === 'string' ? record.text : '');
      return;
    }

    if (eventType === 'response.output_item.added' && record.item?.type === 'function_call') {
      ensureDraft(
        draftKey(record),
        String(record.item.call_id || ''),
        String(record.item.name || ''),
      );
      return;
    }
    if (eventType === 'response.function_call_arguments.delta') {
      const draft = ensureDraft(draftKey(record), '', '');
      draft.argumentsJson += typeof record.delta === 'string' ? record.delta : '';
      handlers.onToolArgsDelta?.(toPublicDraft(draft));
      return;
    }
    if (eventType === 'response.function_call_arguments.done') {
      const draft = ensureDraft(draftKey(record), '', '');
      if (typeof record.arguments === 'string') draft.argumentsJson = record.arguments;
      handlers.onToolArgsDelta?.(toPublicDraft(draft));
      return;
    }
    if (eventType === 'response.output_item.done' && record.item?.type === 'function_call') {
      const draft = ensureDraft(
        draftKey(record),
        String(record.item.call_id || ''),
        String(record.item.name || ''),
      );
      if (typeof record.item.arguments === 'string') draft.argumentsJson = record.item.arguments;
      return;
    }

    if (eventType === 'response.completed' || eventType === 'response.incomplete') {
      finalPayload = record.response || payload;
      complete = true;
      usage = getNovaAgentUsage(finalPayload) ?? getNovaAgentUsage(payload);
      appendFinalText(extractNovaAgentText('openai-responses', record.response));
      // 兜底：某些实现只在最终响应里给完整的 function_call
      for (const call of collectToolCallsFromPayload('openai-responses', record.response)) {
        // 流式响应已经在 output_item.added / arguments.* 事件里创建过草稿；
        // response.completed 又会带一份完整 output，必须按 call_id 合并，
        // 否则同一个工具会被执行两次，下一轮请求也会带重复 call_id。
        const draft = call.callId
          ? [...drafts.values()].find((item) => item.callId === call.callId)
          : undefined;
        const resolved = draft || ensureDraft(call.callId, call.callId, call.name);
        if (call.argumentsJson) resolved.argumentsJson = call.argumentsJson;
      }
      setPhase('completed');
    }
  }

  function handleChatCompletions(record: StreamRecord, payload: unknown) {
    const choice = record.choices?.[0];
    if (!choice) return;

    const content = choice.delta?.content ?? choice.message?.content;
    if (typeof content === 'string') appendText(content);
    else if (Array.isArray(content)) {
      appendText(
        content
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join(''),
      );
    }

    // 部分兼容实现把推理放在 delta.reasoning_content
    const reasoningDelta = choice.delta?.reasoning_content;
    if (typeof reasoningDelta === 'string') appendReasoning(reasoningDelta);

    const toolCalls = choice.delta?.tool_calls ?? choice.message?.tool_calls;
    for (const call of toolCalls || []) {
      // 增量帧只有 index，id/name 仅首帧携带，所以用 index 做键
      const key = String(call.index ?? call.id ?? 0);
      const draft = ensureDraft(key, String(call.id || ''), String(call.function?.name || ''));
      if (typeof call.function?.arguments === 'string') {
        draft.argumentsJson += call.function.arguments;
        handlers.onToolArgsDelta?.(toPublicDraft(draft));
      }
    }

    if (choice.finish_reason) {
      finalPayload = payload;
      complete = true;
      usage = getNovaAgentUsage(payload) ?? usage;
      setPhase('completed');
    }
  }

  function handleAnthropic(record: StreamRecord, payload: unknown) {
    const eventType = record.type || '';

    if (eventType === 'content_block_start') {
      const block = record.content_block;
      if (block?.type === 'text' && typeof block.text === 'string') appendText(block.text);
      if (block?.type === 'tool_use') {
        ensureDraft(String(record.index ?? 0), String(block.id || ''), String(block.name || ''));
      }
      if (block?.type === 'thinking' && typeof block.thinking === 'string') {
        appendReasoning(block.thinking);
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const delta = record.delta;
      if (delta && typeof delta === 'object') {
        if (typeof delta.text === 'string') appendText(delta.text);
        if (typeof delta.thinking === 'string') appendReasoning(delta.thinking);
        if (typeof delta.partial_json === 'string') {
          const draft = ensureDraft(String(record.index ?? 0), '', '');
          draft.argumentsJson += delta.partial_json;
          handlers.onToolArgsDelta?.(toPublicDraft(draft));
        }
      }
      return;
    }

    if (eventType === 'message_delta') {
      usage = getNovaAgentUsage(payload) ?? usage;
      return;
    }

    if (eventType === 'message_stop') {
      finalPayload = payload;
      complete = true;
      usage = getNovaAgentUsage(payload) ?? usage;
      setPhase('completed');
    }
  }

  /**
   * Gemini 的流每帧都是一个完整的 GenerateContentResponse 片段。
   *
   * 与其它三个协议的关键差别：**工具调用不是增量的** —— functionCall 一次性
   * 带着完整 args 到达，没有 id、也没有 arguments.delta 事件。
   * 因此「边流边显示正在写入的代码」在 Gemini 下拿不到中间态，
   * onToolArgsDelta 只会在参数已完整时触发一次（UI 表现为代码整段出现）。
   */
  function handleGemini(record: StreamRecord, payload: unknown) {
    if (record.promptFeedback?.blockReason) {
      throw new Error(`内容被拦截: ${record.promptFeedback.blockReason}`);
    }

    for (const candidate of record.candidates || []) {
      for (const part of candidate.content?.parts || []) {
        if (part.functionCall?.name) {
          geminiCallSeq += 1;
          const key = `gemini-call-${geminiCallSeq}`;
          const draft = ensureDraft(key, key, String(part.functionCall.name));
          draft.argumentsJson = JSON.stringify(part.functionCall.args ?? {});
          handlers.onToolArgsDelta?.(toPublicDraft(draft));
          continue;
        }
        if (typeof part.text !== 'string' || !part.text) continue;
        // includeThoughts 关着时不该出现 thought 片段，出现了也不当正文
        if (part.thought === true) appendReasoning(part.text);
        else appendText(part.text);
      }

      if (candidate.finishReason) {
        finalPayload = payload;
        complete = true;
        usage = getNovaAgentUsage(payload) ?? usage;
        setPhase('completed');
      }
    }

    // usageMetadata 可能出现在没有 finishReason 的中间帧上
    usage = getNovaAgentUsage(payload) ?? usage;
  }

  function appendFinalText(fullText: string) {
    if (!fullText) return;
    if (!text) {
      appendText(fullText);
      return;
    }
    // 最终帧常常重复已流式给出的内容，只补差额
    if (fullText.startsWith(text) && fullText.length > text.length) {
      appendText(fullText.slice(text.length));
    }
  }
}

function toPublicDraft(draft: MutableDraft): NovaToolCallDraft {
  return { callId: draft.callId, name: draft.name, argumentsJson: draft.argumentsJson };
}

/** responses 的条目键：优先 item_id，其次 output_index */
function draftKey(record: StreamRecord): string {
  return String(record.item_id ?? record.item?.id ?? record.output_index ?? 0);
}

/** 从非流式 / 最终响应里兜底捞出工具调用 */
function collectToolCallsFromPayload(
  protocol: TextProviderProtocol,
  data: unknown,
): NovaToolCallDraft[] {
  if (!data || typeof data !== 'object') return [];

  if (protocol === 'openai-chat-completions') {
    const record = data as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    return (record.choices?.[0]?.message?.tool_calls || []).map((call) => ({
      callId: String(call.id || ''),
      name: String(call.function?.name || ''),
      argumentsJson: String(call.function?.arguments || ''),
    }));
  }

  if (protocol === 'anthropic-messages') {
    const record = data as {
      content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }>;
    };
    return (record.content || [])
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        callId: String(block.id || ''),
        name: String(block.name || ''),
        argumentsJson: JSON.stringify(block.input ?? {}),
      }));
  }

  if (protocol === 'google-gemini') {
    const record = data as {
      candidates?: Array<{
        content?: { parts?: Array<{ functionCall?: { name?: string; args?: unknown } }> };
      }>;
    };
    return (record.candidates || [])
      .flatMap((candidate) => candidate.content?.parts || [])
      .filter((part) => Boolean(part.functionCall?.name))
      .map((part, index) => ({
        callId: `gemini-call-${index + 1}`,
        name: String(part.functionCall?.name || ''),
        argumentsJson: JSON.stringify(part.functionCall?.args ?? {}),
      }));
  }

  const record = data as {
    output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
  };
  return (record.output || [])
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      callId: String(item.call_id || ''),
      name: String(item.name || ''),
      argumentsJson: String(item.arguments || ''),
    }));
}

interface StreamRecord {
  type?: string;
  delta?: string | { text?: string; thinking?: string; partial_json?: string };
  text?: string;
  arguments?: string;
  index?: number;
  item_id?: string;
  output_index?: number;
  item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string };
  message?: string | { content?: unknown };
  response?: unknown;
  content_block?: { type?: string; text?: string; id?: string; name?: string; thinking?: string };
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
        functionCall?: { name?: string; args?: unknown };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  choices?: Array<{
    delta?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}
