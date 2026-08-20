'use client';

import { useEffect, useRef } from 'react';
import { Braces, CheckCircle2, CircleDot, Code2, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

interface StreamingCodePanelProps {
  title: string;
  language: string;
  text: string;
  phase?: string;
  elapsed?: number;
  isStreaming: boolean;
  className?: string;
  maxHeight?: string;
  /** 左上角仿窗口的三个彩色圆点。网页复刻流不需要，拆图流保留。 */
  showTrafficDots?: boolean;
}

const MAX_VISIBLE_CHARS = 18_000;

/**
 * 流式模型输出的轻量终端视图。只截显示窗口，传入的 text 仍保留完整内容，
 * 这样长 HTML/JSON 不会因为界面渲染而丢失，用户也能看到持续向下滚动的增量。
 */
export function StreamingCodePanel({
  title,
  language,
  text,
  phase,
  elapsed,
  isStreaming,
  className,
  maxHeight = 'min(42vh, 28rem)',
  showTrafficDots = true,
}: StreamingCodePanelProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const visibleText = text.length > MAX_VISIBLE_CHARS
    ? `…\n${text.slice(-MAX_VISIBLE_CHARS)}`
    : text;
  const lineCount = text ? text.split(/\r?\n/).length : 0;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }, [text]);

  return (
    <section
      className={cn(
        'streaming-code-panel relative flex min-h-0 flex-col overflow-hidden rounded-xl border shadow-2xl',
        className,
      )}
      aria-live="polite"
      aria-label={title}
    >
      <div className="streaming-code-panel__header flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {showTrafficDots && (
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="streaming-code-panel__dot streaming-code-panel__dot--red size-2 rounded-full" />
            <span className="streaming-code-panel__dot streaming-code-panel__dot--yellow size-2 rounded-full" />
            <span className="streaming-code-panel__dot streaming-code-panel__dot--green size-2 rounded-full" />
          </div>
        )}
        <Code2 className={cn('streaming-code-panel__accent size-3.5', showTrafficDots && 'ml-1')} />
        <span className="streaming-code-panel__title min-w-0 truncate text-xs font-medium">{title}</span>
        <span className="streaming-code-panel__language ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
          {language}
        </span>
      </div>

      <div
        ref={bodyRef}
        className="streaming-code-panel__body min-h-0 flex-1 overflow-auto px-3 py-3 font-mono text-[11px] leading-5"
        style={{ maxHeight }}
      >
        {visibleText ? (
          <pre className="m-0 whitespace-pre-wrap break-words">{visibleText}</pre>
        ) : (
          <div className="streaming-code-panel__muted flex items-center gap-2">
            <Braces className="streaming-code-panel__accent size-3.5 animate-pulse" />
            <span>等待模型输出</span>
          </div>
        )}
        {isStreaming && (
          <span
            className="streaming-code-panel__caret ml-0.5 inline-block h-4 w-1.5 translate-y-1 animate-pulse align-baseline"
            aria-hidden="true"
          />
        )}
      </div>

      <div className="streaming-code-panel__footer flex shrink-0 items-center gap-2 border-t px-3 py-1.5 text-[10px]">
        {isStreaming ? (
          <>
            <Loader2 className="streaming-code-panel__accent size-3 animate-spin" />
            <span>{phase || '正在生成'}</span>
          </>
        ) : (
          <>
            <CheckCircle2 className="streaming-code-panel__success size-3" />
            <span>输出完成</span>
          </>
        )}
        <span className="ml-auto tabular-nums">
          {lineCount} 行 · {text.length.toLocaleString()} 字符
          {typeof elapsed === 'number' ? ` · ${elapsed}s` : ''}
        </span>
        <CircleDot className={cn('streaming-code-panel__accent size-3', isStreaming && 'animate-pulse')} />
      </div>
    </section>
  );
}
