// 网页复刻 agent 的主循环。
//
// 一轮 = 请求 → 流式读 → 有工具调用就执行并回传 → 继续；没有工具调用即为终答。
// 每一步都重建固定前缀（见 prompts.ts），所以切图资源和文件清单永远是最新的。

import { nanoid } from 'nanoid';

import {
  buildNovaAgentRequestBody,
  getNovaAgentIncompleteReason,
  postNovaProxyText,
  supportsReasoningSummary,
  type NovaAgentRequestMessage,
  type NovaAgentUsage,
} from '@/lib/nova-agent-protocol';
import { readNovaAgentStream, type NovaAgentPhase } from '@/lib/nova-agent-stream';
import { collectHydratedAssets } from '@/lib/slice-reconstruct';
import { getBlob } from '@/lib/slice-db';
import { requireSliceTextModel, type SliceTextModel } from '@/lib/slice-model-config';
import type { SliceWorkspaceDraft, WebAgentMessage } from '@/lib/slice-types';
import type { TextProviderProtocol } from '@/lib/nova-text-protocol';
import {
  createIdleTimeoutSignal,
  isRetryableAgentError,
  normalizeStreamError,
} from '@/lib/stream-reliability';
import { buildAssetContactSheet } from './asset-sheet';
import { CONTEXT_REFUSE_TOKENS, contextLevel } from './context';
import { extractStreamingEditContent, extractStreamingPath } from './partial-json';
import { buildPinnedPrefix, buildWebAgentSystemPrompt, toAssetBriefs } from './prompts';
import { executeWebAgentTool, WEB_AGENT_TOOLS } from './tools';
import type { ReplicaFiles } from './vfs';

/** 单轮最多跑几步工具调用。超出说明模型陷入了循环，停下来让用户介入。 */
export const MAX_AGENT_STEPS = 12;
const AGENT_MAX_OUTPUT_TOKENS = 8_192;
const AGENT_IDLE_TIMEOUT_MS = 90_000;
const AGENT_MAX_ATTEMPTS = 3;

/**
 * 网页复刻的思考强度。
 *
 * 开源版 registry 没有「思考等级」这一维，这里定为 high：复刻是长程多步工具调用，
 * 降档会明显增加改错行、漏改的概率。实际取值由 buildNovaAgentRequestBody
 * 按协议折算（Responses → reasoning.effort，Gemini → thinkingBudget，其余忽略）。
 */
const AGENT_REASONING_EFFORT = 'high';

export type WebAgentStatus = 'thinking' | 'reading' | 'editing';

export type WebAgentEvent =
  | { type: 'phase'; phase: NovaAgentPhase }
  | { type: 'status'; status: WebAgentStatus; path?: string }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant-text'; text: string }
  | { type: 'edit-stream'; path: string; code: string }
  | { type: 'action'; kind: 'read' | 'edit'; path: string; summary: string; ok: boolean }
  | { type: 'files'; files: ReplicaFiles }
  | { type: 'usage'; usage: NovaAgentUsage };

export type WebAgentStopReason = 'done' | 'max-steps' | 'context-full';

export interface WebAgentTurnResult {
  messages: WebAgentMessage[];
  files: ReplicaFiles;
  usage: NovaAgentUsage | null;
  filesChanged: boolean;
  stopReason: WebAgentStopReason;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 历史消息 → 请求消息。
 * 刻意丢掉 reasoning：推理摘要是输出侧内容，回传既无必要也会白白撑大上下文。
 */
function toRequestMessages(history: WebAgentMessage[]): NovaAgentRequestMessage[] {
  const out: NovaAgentRequestMessage[] = [];
  for (const message of history) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: message.text || '' }] });
      continue;
    }
    if (message.role === 'assistant') {
      const content: NovaAgentRequestMessage['content'] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls || []) {
        content.push({
          type: 'tool_call',
          callId: call.callId,
          name: call.name,
          argumentsJson: call.argumentsJson,
        });
      }
      if (content.length) out.push({ role: 'assistant', content });
      continue;
    }
    const results = (message.toolResults || []).map((result) => ({
      type: 'tool_result' as const,
      callId: result.callId,
      name: result.name,
      output: result.output,
    }));
    if (results.length) out.push({ role: 'tool', content: results });
  }
  return out;
}

async function readSourceDataUrl(workspace: SliceWorkspaceDraft): Promise<string | null> {
  const blob = await getBlob(workspace.sourceImageBlobKey);
  if (!blob) return null;
  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * 跑一轮 agent 对话。
 *
 * 固定前缀所需的源截图与资产总览图只在开头构建一次并在各步之间复用：
 * 它们在一轮之内不会变，重复读 blob、重复合成 canvas 纯属浪费。
 * 但系统提示里的文件行数会随编辑变化，所以那部分每步都重算。
 */
export async function runWebAgentTurn(params: {
  workspace: SliceWorkspaceDraft;
  files: ReplicaFiles;
  history: WebAgentMessage[];
  userText: string;
  signal?: AbortSignal;
  onEvent?: (event: WebAgentEvent) => void;
}): Promise<WebAgentTurnResult> {
  const { workspace, history, userText, signal } = params;
  const emit = params.onEvent ?? (() => {});

  const textModel = requireSliceTextModel('sliceReconstruct');
  const protocol = textModel.protocol;
  const reasoningSummary = supportsReasoningSummary(protocol);

  const assetBriefs = toAssetBriefs(workspace);
  const [sourceImageDataUrl, contactSheetDataUrl] = await Promise.all([
    readSourceDataUrl(workspace),
    collectHydratedAssets(workspace).then(buildAssetContactSheet),
  ]);

  let workingFiles = params.files;
  let filesChanged = false;
  let lastUsage: NovaAgentUsage | null = null;
  let stopReason: WebAgentStopReason = 'done';

  const turnMessages: WebAgentMessage[] = [
    { id: nanoid(), role: 'user', text: userText, createdAt: nowIso() },
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step += 1) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');

    // 每步复查：上一步的工具结果可能刚把上下文顶过阈值
    if (lastUsage && contextLevel(lastUsage.inputTokens) === 'blocked') {
      stopReason = 'context-full';
      break;
    }

    emit({ type: 'status', status: 'thinking' });

    const prefix = buildPinnedPrefix({
      systemPrompt: buildWebAgentSystemPrompt({
        files: workingFiles,
        assets: assetBriefs,
        screen: workspace.screen,
      }),
      sourceImageDataUrl,
      contactSheetDataUrl,
    });
    const requestMessages = [...prefix, ...toRequestMessages([...history, ...turnMessages])];

    const streamResult = await requestWithRetry({
      textModel,
      protocol,
      reasoningSummary,
      messages: requestMessages,
      signal,
      emit,
    });

    if (streamResult.usage) {
      lastUsage = streamResult.usage;
      emit({ type: 'usage', usage: streamResult.usage });
    }

    const incompleteReason = getNovaAgentIncompleteReason(streamResult.finalPayload);
    if (incompleteReason === 'max_output_tokens') {
      throw new Error('模型输出超出长度上限，请把改动拆小一些再试');
    }

    const assistantMessage: WebAgentMessage = {
      id: nanoid(),
      role: 'assistant',
      createdAt: nowIso(),
      ...(streamResult.text ? { text: streamResult.text } : {}),
      ...(streamResult.reasoning ? { reasoning: streamResult.reasoning } : {}),
      ...(streamResult.toolCalls.length
        ? { toolCalls: streamResult.toolCalls.map((call) => ({ ...call })) }
        : {}),
    };
    turnMessages.push(assistantMessage);

    if (streamResult.text) emit({ type: 'assistant-text', text: streamResult.text });

    // 没有工具调用 = 模型给出了终答
    if (!streamResult.toolCalls.length) {
      stopReason = 'done';
      break;
    }

    const toolResults: NonNullable<WebAgentMessage['toolResults']> = [];
    const actions: NonNullable<WebAgentMessage['actions']> = [];

    for (const call of streamResult.toolCalls) {
      const execution = executeWebAgentTool(call.name, call.argumentsJson, workingFiles);
      if (execution.files !== workingFiles) {
        workingFiles = execution.files;
        filesChanged = true;
        emit({ type: 'files', files: workingFiles });
      }
      toolResults.push({ callId: call.callId, name: call.name, output: execution.output });
      actions.push({
        kind: execution.kind,
        path: execution.path,
        summary: execution.summary,
        ok: execution.ok,
      });
      emit({
        type: 'action',
        kind: execution.kind,
        path: execution.path,
        summary: execution.summary,
        ok: execution.ok,
      });
    }

    turnMessages.push({
      id: nanoid(),
      role: 'tool',
      createdAt: nowIso(),
      toolResults,
      actions,
    });

    if (step === MAX_AGENT_STEPS - 1) stopReason = 'max-steps';
  }

  return {
    messages: [...history, ...turnMessages],
    files: workingFiles,
    usage: lastUsage,
    filesChanged,
    stopReason,
  };
}

/**
 * 发一次请求并读完流，失败按可重试性退避重试。
 *
 * 空闲超时用 SSE 每一帧（含 keepalive）续时：推理模型可能几十秒不吐 token，
 * 墙钟超时会把这种完全正常的请求误杀。
 */
async function requestWithRetry(params: {
  textModel: SliceTextModel;
  protocol: TextProviderProtocol;
  reasoningSummary: boolean;
  messages: NovaAgentRequestMessage[];
  signal?: AbortSignal;
  emit: (event: WebAgentEvent) => void;
}) {
  const requestBody = buildNovaAgentRequestBody({
    protocol: params.protocol,
    model: params.textModel.modelId,
    stream: true,
    effort: AGENT_REASONING_EFFORT,
    reasoningSummary: params.reasoningSummary,
    maxOutputTokens: AGENT_MAX_OUTPUT_TOKENS,
    tools: WEB_AGENT_TOOLS,
    messages: params.messages,
  });

  let lastError: unknown;
  for (let attempt = 1; attempt <= AGENT_MAX_ATTEMPTS; attempt += 1) {
    const idle = createIdleTimeoutSignal(params.signal, AGENT_IDLE_TIMEOUT_MS);
    try {
      const response = await postNovaProxyText({
        protocol: params.protocol,
        baseUrl: params.textModel.baseUrl,
        apiKey: params.textModel.apiKey,
        model: params.textModel.modelId,
        stream: true,
        requestBody,
        signal: idle.signal,
      });
      if (!response.ok) {
        throw await readWebAgentHttpError(response);
      }

      let activeEditPath: string | null = null;
      return await readNovaAgentStream(response, params.protocol, idle.signal, {
        onActivity: idle.touch,
        onPhase: (phase) => params.emit({ type: 'phase', phase }),
        onReasoningDelta: (_delta, accumulated) =>
          params.emit({ type: 'reasoning', text: accumulated }),
        onToolCallStart: (call) => {
          if (call.name === 'edit_file') {
            activeEditPath = null;
            params.emit({ type: 'status', status: 'editing' });
          } else {
            params.emit({ type: 'status', status: 'reading' });
          }
        },
        onToolArgsDelta: (call) => {
          if (call.name !== 'edit_file') return;
          // path 先于 content 到达，拿到就更新一次「正在编辑 xxx」的标签
          const path = extractStreamingPath(call.argumentsJson);
          if (path && path !== activeEditPath) {
            activeEditPath = path;
            params.emit({ type: 'status', status: 'editing', path });
          }
          params.emit({
            type: 'edit-stream',
            path: activeEditPath || '',
            code: extractStreamingEditContent(call.argumentsJson),
          });
        },
      });
    } catch (error) {
      lastError = error;
      // 用户主动取消不重试
      if (params.signal?.aborted) throw error;
      if (attempt >= AGENT_MAX_ATTEMPTS || !isRetryableAgentError(error)) {
        throw normalizeStreamError(error, AGENT_MAX_ATTEMPTS);
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    } finally {
      idle.cleanup();
    }
  }

  throw normalizeStreamError(lastError, AGENT_MAX_ATTEMPTS);
}

/** 保留供应商返回的校验详情，避免所有协议错误都只显示笼统的 400。 */
async function readWebAgentHttpError(response: Response): Promise<Error> {
  const raw = await response.text().catch(() => '');
  let detail = raw.trim();
  if (detail) {
    try {
      const parsed: unknown = JSON.parse(detail);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as {
          error?: { message?: unknown } | string;
          message?: unknown;
        };
        const message = typeof record.error === 'string'
          ? record.error
          : record.error && typeof record.error.message === 'string'
            ? record.error.message
            : typeof record.message === 'string'
              ? record.message
              : '';
        if (message) detail = message;
      }
    } catch {
      // 非 JSON 响应直接使用原文。
    }
  }
  return new Error(`${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
}

/** 循环因上下文塞满而中止时，给用户的说明文案 */
export function describeStopReason(reason: WebAgentStopReason): string | null {
  if (reason === 'context-full') {
    return `上下文已达 ${Math.round(CONTEXT_REFUSE_TOKENS / 1000)}K 上限，本轮提前结束。请点「清理对话」后继续。`;
  }
  if (reason === 'max-steps') {
    return `已连续执行 ${MAX_AGENT_STEPS} 步仍未完成，先停下来。可以把要求拆得更具体一些再试。`;
  }
  return null;
}
