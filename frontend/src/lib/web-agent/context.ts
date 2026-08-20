// 网页复刻 agent 的上下文预算。
//
// 关键取舍：token 数不做估算，直接用 API 在 response.completed 帧里返回的 usage。
// 前端没有 tokenizer，任何字符级估算都会在中英混排 + 图片输入下明显偏差；
// 而 usage.input_tokens 就是「这次喂给模型多少」的权威值，正是 200K 窗口要衡量的东西。

import type { NovaAgentUsage } from '@/lib/nova-agent-protocol';

/** 上下文窗口上限，仅用于展示分母 */
export const CONTEXT_LIMIT_TOKENS = 200_000;
/** 到这里开始提醒用户该清理了 */
export const CONTEXT_WARN_TOKENS = 140_000;
/** 到这里拒绝继续对话，必须先清理 */
export const CONTEXT_REFUSE_TOKENS = 175_000;

export type ContextLevel = 'ok' | 'warn' | 'blocked';

/**
 * 依据最近一次请求的 input_tokens 判定档位。
 *
 * 注意这是「上一次」请求的值，比即将发出的那次少一条消息或一份工具结果。
 * 175K 相对 200K 留出的 25K 余量正是为了吸收这个滞后——单条用户消息或单次
 * 400 行读取都远小于此，所以门控不会漏判。
 */
export function contextLevel(inputTokens: number | null | undefined): ContextLevel {
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return 'ok';
  if (inputTokens >= CONTEXT_REFUSE_TOKENS) return 'blocked';
  if (inputTokens >= CONTEXT_WARN_TOKENS) return 'warn';
  return 'ok';
}

/** 首轮请求前没有任何 usage，显示 — 而不是用 0 冒充精确 */
export function formatTokens(tokens: number | null | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '—';
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
  return `${(tokens / 1000).toFixed(1)}K`;
}

export function contextRatio(inputTokens: number | null | undefined): number {
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens)) return 0;
  return Math.min(1, Math.max(0, inputTokens / CONTEXT_LIMIT_TOKENS));
}

/** 头部 hover 的用量明细 */
export function describeUsage(usage: NovaAgentUsage | null | undefined): string {
  if (!usage) return '尚未收到用量数据';
  const parts = [
    `输入 ${formatTokens(usage.inputTokens)}`,
    `输出 ${formatTokens(usage.outputTokens)}`,
  ];
  if (typeof usage.cachedTokens === 'number' && usage.cachedTokens > 0) {
    parts.push(`缓存命中 ${formatTokens(usage.cachedTokens)}`);
  }
  if (typeof usage.reasoningTokens === 'number' && usage.reasoningTokens > 0) {
    parts.push(`推理 ${formatTokens(usage.reasoningTokens)}`);
  }
  return parts.join(' · ');
}
