// 流式请求的可靠性工具：子信号、空闲超时、可重试判定。
//
// 从 agent-chat-client.ts 原地提取，供 agent 聊天与网页复刻 agent 共用。
// 提取而不是复制的原因很实际：这几个判定（哪些错误值得重试、空闲多久算断线）
// 是靠线上问题一条条攒出来的，两份副本迟早会分叉，而分叉的那份必然是没人维护的那份。

export class AgentRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`请求超过 ${Math.round(timeoutMs / 1000)} 秒未响应`);
    this.name = 'AgentRequestTimeoutError';
  }
}

/** 派生一个可独立 abort、同时跟随父信号的子信号 */
export function createAttemptSignal(parentSignal?: AbortSignal): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!parentSignal) {
    return {
      signal: controller.signal,
      abort: reason => controller.abort(reason),
      cleanup: () => undefined,
    };
  }
  if (parentSignal.aborted) controller.abort(parentSignal.reason);
  const abortFromParent = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    abort: reason => controller.abort(reason),
    cleanup: () => parentSignal.removeEventListener('abort', abortFromParent),
  };
}

/**
 * 空闲超时：有数据/活动时调用 touch() 续时，连续 idleMs 无活动才 abort。
 *
 * 用空闲而不是墙钟计时，是因为推理模型可能几十秒不吐 token 却完全正常；
 * 墙钟超时会把这种请求误杀。SSE 的 keepalive 帧正好用来 touch()。
 */
export function createIdleTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  idleMs: number,
): {
  signal: AbortSignal;
  touch: () => void;
  cleanup: () => void;
} {
  const attempt = createAttemptSignal(parentSignal);
  const timeoutError = new AgentRequestTimeoutError(idleMs);
  let timeoutId = 0;

  const touch = () => {
    if (attempt.signal.aborted) return;
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      if (!attempt.signal.aborted) attempt.abort(timeoutError);
    }, idleMs);
  };

  touch();

  return {
    signal: attempt.signal,
    touch,
    cleanup: () => {
      window.clearTimeout(timeoutId);
      attempt.cleanup();
    },
  };
}

/** 值得重试的错误：限流、网关抖动、网络中断、空闲超时 */
export function isRetryableAgentError(error: unknown): boolean {
  if (error instanceof AgentRequestTimeoutError) return true;
  if (!(error instanceof Error)) return false;
  const lower = error.message.toLowerCase();
  return [
    '408', '409', '425', '429', '500', '502', '503', '504',
    'failed to fetch', 'network', 'load failed', 'econnreset', 'terminated',
    'timeout', 'timed out', '超时', '超过',
    'rate limit', 'temporarily', 'overloaded',
  ].some(keyword => lower.includes(keyword));
}

/** 把底层异常翻译成用户能看懂的一句话 */
export function normalizeStreamError(error: unknown, maxAttempts: number): Error {
  if (error instanceof AgentRequestTimeoutError) {
    return new Error(`${error.message}，已自动重试 ${maxAttempts} 次仍未成功`);
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      lower.includes('failed to fetch')
      || lower.includes('network')
      || lower.includes('load failed')
      || lower.includes('econnreset')
      || lower.includes('terminated')
    ) {
      return new Error(`网络连接失败，已自动重试 ${maxAttempts} 次仍未成功`);
    }
    return error;
  }
  return new Error(String(error));
}
