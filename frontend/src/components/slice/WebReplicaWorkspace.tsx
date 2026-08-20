'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  Code2,
  Loader2,
  Maximize,
  MessageSquare,
  Pencil,
  RefreshCw,
  RotateCcw,
  Scissors,
  Send,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { hasSliceTextModel } from '@/lib/slice-model-config';
import { handleMarkdownCodeCopyButtonClick } from '@/lib/markdown-code-copy';
import { renderMarkdown, renderReasoning } from '@/lib/render-reasoning';
import { getBlob } from '@/lib/slice-db';
import type { SliceWorkspaceDraft, WebAgentMessage } from '@/lib/slice-types';
import { cn } from '@/lib/utils';
import {
  collectHydratedAssets,
  collectReferenceAssetDescriptors,
  composeReplicaPreview,
  findUnresolvedAssetIds,
  requestReplicaGeneration,
  resolveReplicaFiles,
  type HydratedAsset,
} from '@/lib/slice-reconstruct';
import { describeStopReason, runWebAgentTurn, type WebAgentStatus } from '@/lib/web-agent/agent-loop';
import {
  CONTEXT_LIMIT_TOKENS,
  CONTEXT_REFUSE_TOKENS,
  contextLevel,
  contextRatio,
  describeUsage,
  formatTokens,
} from '@/lib/web-agent/context';
import type { ReplicaFiles } from '@/lib/web-agent/vfs';
import { useSliceStore } from './stores/use-slice-store';
import { StreamingCodePanel } from './StreamingCodePanel';

interface WebReplicaWorkspaceProps {
  onConfigureApiKey: () => void;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  /** 向父级报告生成/对话请求状态，避免请求中切换 Tab 卸载页面。 */
  onTaskStateChange?: (busy: boolean) => void;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('源图读取失败'));
    reader.readAsDataURL(blob);
  });
}

function languageOf(path: string): string {
  if (path.endsWith('.css')) return 'CSS';
  if (path.endsWith('.js')) return 'JS';
  return 'HTML';
}

/** 一轮进行中的对话。落盘前先在界面上滚起来，用户不用盯着空白等。 */
interface LiveTurn {
  userText: string;
  reasoning: string;
  assistantText: string;
  actions: { kind: 'read' | 'edit'; path: string; summary: string; ok: boolean }[];
  status: WebAgentStatus;
  path: string;
}

const EMPTY_TURN: LiveTurn = {
  userText: '',
  reasoning: '',
  assistantText: '',
  actions: [],
  status: 'thinking',
  path: '',
};

/** 可折叠的思考块。结束后自动收起，点击可展开回看。 */
function ThinkingBlock({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const renderedText = useMemo(() => renderReasoning(text), [text]);
  const expanded = live || open;
  if (!text.trim()) return null;
  return (
    <div className="mr-6 rounded-lg border border-dashed border-border/70 bg-muted/40">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain className={cn('size-3.5 shrink-0', live && 'animate-pulse')} />
        <span>{live ? '思考中…' : '已思考'}</span>
        {expanded ? (
          <ChevronDown className="ml-auto size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="ml-auto size-3.5 shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="max-h-48 overflow-y-auto px-2.5 pb-2 text-[11px] leading-5 text-muted-foreground">
          <div
            className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: renderedText }}
          />
        </div>
      )}
    </div>
  );
}

/** 助手消息沿用 Agent 模式的 Markdown 渲染和代码复制交互。 */
function AssistantMessageText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const renderedText = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={cn(
        'min-w-0 break-words [overflow-wrap:anywhere]',
        streaming ? 'md-streaming' : 'md-message',
      )}
      onClick={(event) => {
        if (!handleMarkdownCodeCopyButtonClick(event.target)) return;
        event.preventDefault();
      }}
      dangerouslySetInnerHTML={{ __html: renderedText }}
    />
  );
}

function ActionRow({
  action,
  live,
}: {
  action: { kind: 'read' | 'edit'; path: string; summary: string; ok: boolean };
  live?: boolean;
}) {
  const Icon = action.kind === 'edit' ? Pencil : BookOpen;
  return (
    <div
      className={cn(
        'mr-6 flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]',
        action.ok ? 'bg-muted/60 text-muted-foreground' : 'bg-destructive/10 text-destructive',
      )}
    >
      {action.ok ? (
        <Icon className={cn('mt-0.5 size-3.5 shrink-0', live && 'animate-pulse')} />
      ) : (
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span className="min-w-0 break-words">{action.summary}</span>
    </div>
  );
}

/**
 * 网页复刻工作区：
 * - 首次生成：单次视觉调用产出 index.html / styles.css / script.js 三个文件
 * - 后续微调：真正的 agent 循环，用 read_file / edit_file 按行改动，不重发整页
 * - 上下文用量取 API 返回的 input_tokens，到 175K 拒绝继续
 */
export function WebReplicaWorkspace({ onConfigureApiKey, showToast, onTaskStateChange }: WebReplicaWorkspaceProps) {
  const workspace = useSliceStore((s) => s.activeWorkspace);
  const setReplicaFiles = useSliceStore((s) => s.setReplicaFiles);
  const setWebAgentMessages = useSliceStore((s) => s.setWebAgentMessages);
  const setWebAgentUsage = useSliceStore((s) => s.setWebAgentUsage);
  const clearWebAgentConversation = useSliceStore((s) => s.clearWebAgentConversation);

  const [generating, setGenerating] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [assetState, setAssetState] = useState<{ signature: string; assets: HydratedAsset[] }>({
    // 用一个不可能等于任何真实签名的初值，保证首帧不会误判为"已就绪"
    signature: '__pending__',
    assets: [],
  });
  const [streamText, setStreamText] = useState('');
  const [streamReasoning, setStreamReasoning] = useState('');
  const [streamPhase, setStreamPhase] = useState('正在准备模型输入');
  const [editStream, setEditStream] = useState('');
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [previewZoom, setPreviewZoom] = useState<number | null>(null);
  const [previewViewport, setPreviewViewport] = useState({ width: 0, height: 0 });
  /** 本轮编辑产生的中间文件状态，用于在落盘前就刷新预览 */
  const [pendingFiles, setPendingFiles] = useState<ReplicaFiles | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const chatAutoScrolledRef = useRef(false);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);

  const busy = generating || agentBusy;
  const hasSlices = (workspace?.assets ?? []).some((a) => !a.hidden);
  const files = useMemo(() => resolveReplicaFiles(workspace), [workspace]);

  const messages = workspace?.webAgentMessages ?? [];
  const contextTokens = workspace?.webAgentContextTokens ?? null;
  const contextBlocked = contextLevel(contextTokens) === 'blocked';
  const level = contextLevel(contextTokens);

  const previewWidth = Math.max(1, Math.round(workspace?.screen.width ?? 1));
  const previewHeight = Math.max(1, Math.round(workspace?.screen.height ?? 1));

  // 可见切图的 blob key 组合。变了才需要重新读图，避免每次 workspace 更新都读一遍 IndexedDB。
  const assetsSignature = (workspace?.assets ?? [])
    .filter((a) => !a.hidden)
    .map((a) => a.currentBlobKey)
    .join(',');

  const effectiveFiles = pendingFiles ?? files;
  // 切图还没读完就合成，asset:<id> 会以坏图形式闪一下。
  // 用签名比对确认手上的 dataUrl 确实对应当前这批切图，再渲染。
  const assetsReady = assetState.signature === assetsSignature;
  const previewHtml = useMemo(
    () =>
      effectiveFiles && assetsReady
        ? composeReplicaPreview(effectiveFiles, assetState.assets, { previewWidth, previewHeight })
        : '',
    [effectiveFiles, assetsReady, assetState.assets, previewWidth, previewHeight],
  );

  useEffect(() => {
    onTaskStateChange?.(busy);
    return () => onTaskStateChange?.(false);
  }, [busy, onTaskStateChange]);

  // 预览区尺寸变化时重新计算「适应窗口」比例
  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!viewport) return;
    const updateSize = () => {
      setPreviewViewport({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    updateSize();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateSize);
      observer.observe(viewport);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [hasSlices, busy, previewHtml]);

  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 只负责把切图读成 dataUrl；预览 HTML 由 useMemo 派生，不在 effect 里 setState。
  // 记下签名一并存，供渲染侧确认这批 dataUrl 是否已对应当前切图。
  useEffect(() => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws) return;
    let cancelled = false;
    void collectHydratedAssets(ws).then((assets) => {
      if (!cancelled) setAssetState({ signature: assetsSignature, assets });
    });
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, assetsSignature]);

  // 对话滚动到底部。
  //
  // 这里必须直接写目标容器的 scrollTop，不能用 sentinel + scrollIntoView：
  // scrollIntoView 会把**所有**可滚动祖先一起滚动（含 WorkspaceShell 的页面级
  // xl:overflow-y-auto 与 document），而本组件挂载时该 effect 就会执行一次，
  // 于是「点击网页复刻」会把整个站点的 UI 顶上去。scrollTop 天然只作用于自身。
  //
  // 首次（挂载或切回本 tab）直接落到底部；之后只在用户本来就贴着底部时跟随，
  // 避免流式输出期间把正在往上翻阅历史的用户拽回去。
  useEffect(() => {
    const container = chatScrollRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (chatAutoScrolledRef.current && distanceToBottom > 80) return;
    chatAutoScrolledRef.current = true;
    container.scrollTop = container.scrollHeight;
  }, [messages.length, liveTurn]);

  const getSourceDataUrl = useCallback(async (ws: SliceWorkspaceDraft): Promise<string | null> => {
    const blob = await getBlob(ws.sourceImageBlobKey);
    if (!blob) return null;
    return await blobToDataUrl(blob);
  }, []);

  const requireApiKey = useCallback((): boolean => {
    if (hasSliceTextModel('sliceReconstruct')) return true;
    showToast('请先在「设置 → 模型」中为「网页复刻」指定文本模型', 'error');
    onConfigureApiKey();
    return false;
  }, [onConfigureApiKey, showToast]);

  // ===== 首次生成 / 重新生成 =====

  const handleGenerate = useCallback(async () => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws || !requireApiKey()) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setElapsed(0);
    setStreamText('');
    setStreamReasoning('');
    setStreamPhase('正在准备模型输入');

    try {
      const dataUrl = await getSourceDataUrl(ws);
      if (!dataUrl) {
        showToast('源图尚未加载完成，请稍后重试', 'error');
        return;
      }

      const referenceAssets = collectReferenceAssetDescriptors(ws);
      const result = await requestReplicaGeneration({
        sourceImageDataUrl: dataUrl,
        width: ws.screen.width,
        height: ws.screen.height,
        referenceAssets,
        signal: controller.signal,
        onStreamStart: () => setStreamPhase('已连接，模型思考中'),
        onPhase: (phase) => {
          if (phase === 'reasoning') setStreamPhase('模型思考中');
          if (phase === 'responding') setStreamPhase('正在生成 HTML/CSS/JS');
        },
        onReasoningDelta: setStreamReasoning,
        onDelta: (_delta, accumulated) => setStreamText(accumulated),
      });

      if (controller.signal.aborted) return;

      await setReplicaFiles(result.files);
      // 整页被替换后，历史里的行号与读到的内容全部失效。
      // 留着只会让 agent 依据不存在的行号继续编辑。
      if ((ws.webAgentMessages?.length ?? 0) > 0) {
        await clearWebAgentConversation();
      }
      setPreviewZoom(null);

      // 模型偶尔会编造不存在的 asset:<id>。不检出的话导出后就是裂图，
      // 而用户只会觉得「这个工具导出的网页是坏的」，无从定位。
      const unresolved = findUnresolvedAssetIds(result.files['index.html'], referenceAssets);
      if (unresolved.length > 0) {
        showToast(
          `生成结果引用了 ${unresolved.length} 个不存在的切图（${unresolved.slice(0, 3).join('、')}），` +
            '这些图位置会是空白，可在对话中要求修正',
          'error',
        );
      } else if (result.warning) {
        showToast(result.warning, 'info');
      } else {
        showToast('网页复刻完成', 'success');
      }
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        showToast('已取消网页复刻', 'info');
      } else {
        showToast(err instanceof Error ? err.message : '网页复刻失败', 'error');
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }, [clearWebAgentConversation, getSourceDataUrl, requireApiKey, setReplicaFiles, showToast]);

  // ===== Agent 对话 =====

  const handleChatSubmit = useCallback(async () => {
    const text = prompt.trim();
    const ws = useSliceStore.getState().activeWorkspace;
    const currentFiles = resolveReplicaFiles(ws);
    if (!text || busy || !ws || !currentFiles || contextBlocked) return;
    if (!requireApiKey()) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setPrompt('');
    setAgentBusy(true);
    setElapsed(0);
    setEditStream('');
    setLiveTurn({ ...EMPTY_TURN, userText: text });

    try {
      const result = await runWebAgentTurn({
        workspace: ws,
        files: currentFiles,
        history: ws.webAgentMessages ?? [],
        userText: text,
        signal: controller.signal,
        onEvent: (event) => {
          setLiveTurn((turn) => {
            if (!turn) return turn;
            switch (event.type) {
              case 'status':
                return { ...turn, status: event.status, path: event.path ?? turn.path };
              case 'reasoning':
                return { ...turn, reasoning: event.text };
              case 'assistant-text':
                return { ...turn, assistantText: event.text };
              case 'action':
                return {
                  ...turn,
                  actions: [
                    ...turn.actions,
                    { kind: event.kind, path: event.path, summary: event.summary, ok: event.ok },
                  ],
                };
              default:
                return turn;
            }
          });
          if (event.type === 'edit-stream') setEditStream(event.code);
          // 工具改完文件立刻刷新预览，用户不必等整轮结束落盘
          if (event.type === 'files') setPendingFiles(event.files);
        },
      });

      if (controller.signal.aborted) return;

      await setWebAgentMessages(result.messages);
      if (result.usage) await setWebAgentUsage(result.usage);
      if (result.filesChanged) await setReplicaFiles(result.files);

      const stopNote = describeStopReason(result.stopReason);
      if (stopNote) showToast(stopNote, 'info');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        showToast('已取消本轮对话', 'info');
      } else {
        showToast(err instanceof Error ? err.message : '对话失败', 'error');
      }
    } finally {
      setAgentBusy(false);
      setLiveTurn(null);
      setEditStream('');
      // 落盘后交回持久化状态，避免中间态和已保存内容长期并存
      setPendingFiles(null);
      abortRef.current = null;
    }
  }, [
    busy,
    contextBlocked,
    prompt,
    requireApiKey,
    setReplicaFiles,
    setWebAgentMessages,
    setWebAgentUsage,
    showToast,
  ]);

  const handleClearConversation = useCallback(async () => {
    setClearOpen(false);
    await clearWebAgentConversation();
    showToast('对话已清理，网页文件保留', 'success');
  }, [clearWebAgentConversation, showToast]);

  // ===== 预览缩放 =====

  const fitScale =
    previewViewport.width > 0 && previewViewport.height > 0
      ? Math.min(
          1,
          Math.max(0.1, (previewViewport.width - 32) / previewWidth),
          Math.max(0.1, (previewViewport.height - 32) / previewHeight),
        )
      : 1;
  const effectivePreviewZoom = previewZoom ?? fitScale;
  const scaledPreviewWidth = Math.max(1, Math.round(previewWidth * effectivePreviewZoom));
  const scaledPreviewHeight = Math.max(1, Math.round(previewHeight * effectivePreviewZoom));
  const adjustPreviewZoom = (factor: number) => {
    setPreviewZoom((current) => Math.min(4, Math.max(0.1, (current ?? fitScale) * factor)));
  };

  // 代码面板：整页生成时全程显示；agent 只在「正在编辑」时显示，
  // 思考与阅读不弹窗（思考内容渲染在对话里的思考块）。
  const editing = liveTurn?.status === 'editing';
  const showCodePanel = generating || editing;
  const panelText = generating ? streamText || streamReasoning : editStream;
  const panelLanguage = generating
    ? streamText
      ? 'HTML/CSS/JS'
      : '思考'
    : languageOf(liveTurn?.path || '');
  const panelPhase = generating
    ? streamPhase
    : `正在编辑 ${liveTurn?.path || '文件'}`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">网页复刻</h2>
          <p className="text-xs text-muted-foreground">
            生成 index.html / styles.css / script.js 三个文件 · AI 按行编辑 · 实时预览
          </p>
        </div>
        <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={busy || !hasSlices}>
          {generating ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {files ? '重新生成' : '开始生成网页复刻'}
        </Button>
      </div>

      {!hasSlices ? (
        <div className="grid flex-1 place-items-center rounded-2xl border border-dashed border-border">
          <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
            <Scissors className="size-10 text-muted-foreground" />
            <h3 className="text-base font-semibold">请先进行切图</h3>
            <p className="text-sm text-muted-foreground">
              在「图片拆图」子标签中完成切图后，即可开始生成网页复刻。
            </p>
          </div>
        </div>
      ) : generating && !previewHtml ? (
        /* 首次生成：先显示思考流填补推理期的空白，HTML 开始产出后切换为代码 */
        <div className="flex min-h-0 flex-1 rounded-2xl border border-border bg-muted/30 p-3">
          <StreamingCodePanel
            className="h-full w-full"
            title="网页复刻流"
            language={panelLanguage}
            text={panelText}
            phase={panelPhase}
            elapsed={elapsed}
            isStreaming
            maxHeight="none"
            showTrafficDots={false}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* 预览 */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-muted/30">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-background/80 px-3 py-2">
              <span className="text-xs font-medium text-muted-foreground">网页预览</span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-sm" onClick={() => adjustPreviewZoom(0.8)} disabled={!previewHtml} title="缩小预览" aria-label="缩小预览">
                  <ZoomOut className="size-4" />
                </Button>
                <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
                  {Math.round(effectivePreviewZoom * 100)}%
                </span>
                <Button variant="ghost" size="icon-sm" onClick={() => adjustPreviewZoom(1.25)} disabled={!previewHtml} title="放大预览" aria-label="放大预览">
                  <ZoomIn className="size-4" />
                </Button>
                <div className="mx-1 h-4 w-px bg-border" />
                <Button variant="ghost" size="icon-sm" onClick={() => setPreviewZoom(1)} disabled={!previewHtml} title="恢复原比例（100%）" aria-label="恢复原比例（100%）">
                  <RotateCcw className="size-4" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => setPreviewZoom(null)} disabled={!previewHtml} title="适应窗口" aria-label="适应窗口">
                  <Maximize className="size-4" />
                </Button>
              </div>
            </div>
            <div ref={previewViewportRef} className="relative min-h-0 flex-1 overflow-auto bg-muted/30">
              {previewHtml ? (
                <div className="flex min-h-full min-w-full items-start justify-start p-4">
                  <div className="relative mx-auto shrink-0 overflow-hidden" style={{ width: scaledPreviewWidth, height: scaledPreviewHeight }}>
                    <iframe
                      title="网页复刻预览"
                      className={cn('absolute left-0 top-0 border-0 transition-opacity', busy && 'opacity-50')}
                      style={{
                        width: previewWidth,
                        height: previewHeight,
                        transform: `scale(${effectivePreviewZoom})`,
                        transformOrigin: 'top left',
                      }}
                      /*
                       * 只给 allow-scripts、不给 allow-same-origin：
                       * srcDoc 因此运行在不透明源里——script.js 能跑，但拿不到父页面。
                       * 两者同时给等于沙箱失效，绝不能这么写。
                       */
                      sandbox="allow-scripts"
                      srcDoc={previewHtml}
                    />
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <Code2 className="size-8" />
                    <p className="text-sm">点击「开始生成网页复刻」生成预览</p>
                  </div>
                </div>
              )}
              {showCodePanel && (
                <div className="pointer-events-none absolute inset-3 z-10 md:left-auto md:w-[min(34rem,calc(100%-1.5rem))]">
                  <StreamingCodePanel
                    className="pointer-events-auto"
                    title="网页复刻流"
                    language={panelLanguage}
                    text={panelText}
                    phase={panelPhase}
                    elapsed={elapsed}
                    isStreaming
                    maxHeight="min(60vh, 34rem)"
                    showTrafficDots={false}
                  />
                </div>
              )}
            </div>
          </div>

          {/* 对话 */}
          <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <MessageSquare className="size-4 shrink-0" />
              <span className="text-sm font-medium">AI 对话微调</span>
              <div
                className="ml-auto flex items-center gap-1.5"
                title={
                  contextTokens === null
                    ? '首轮请求后显示实际用量'
                    : describeUsage(workspace?.webAgentLastUsage ?? null)
                }
              >
                <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      level === 'blocked' ? 'bg-destructive' : level === 'warn' ? 'bg-amber-500' : 'bg-primary/60',
                    )}
                    style={{ width: `${Math.max(2, contextRatio(contextTokens) * 100)}%` }}
                  />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {formatTokens(contextTokens)} / {formatTokens(CONTEXT_LIMIT_TOKENS)}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setClearOpen(true)}
                disabled={busy || messages.length === 0}
                title="清理对话"
                aria-label="清理对话"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div ref={chatScrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {messages.length === 0 && !liveTurn ? (
                <p className="text-xs text-muted-foreground">
                  {files
                    ? '描述你想修改的内容，例如「把标题改成蓝色」「点击按钮展开详情」。AI 会先阅读相关文件，再按行改动。'
                    : '先生成网页复刻，之后就可以在这里对话微调。'}
                </p>
              ) : (
                messages.map((msg) => <PersistedMessage key={msg.id} message={msg} />)
              )}

              {liveTurn && (
                <>
                  <div className="ml-6 break-words rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
                    {liveTurn.userText}
                  </div>
                  <ThinkingBlock text={liveTurn.reasoning} live={liveTurn.status === 'thinking'} />
                  {liveTurn.actions.map((action, i) => (
                    <ActionRow key={i} action={action} />
                  ))}
                  {liveTurn.status !== 'thinking' && (
                    <ActionRow
                      live
                      action={{
                        kind: liveTurn.status === 'editing' ? 'edit' : 'read',
                        path: liveTurn.path,
                        summary: `${liveTurn.status === 'editing' ? '正在编辑' : '正在阅读'} ${liveTurn.path || '…'}`,
                        ok: true,
                      }}
                    />
                  )}
                  {liveTurn.assistantText && (
                    <div className="mr-6 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                      <AssistantMessageText text={liveTurn.assistantText} streaming />
                    </div>
                  )}
                </>
              )}
            </div>

            {contextBlocked && (
              <div className="flex shrink-0 items-start gap-1.5 border-t border-border bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  上下文已达 {formatTokens(CONTEXT_REFUSE_TOKENS)} 上限，无法继续对话。请点右上角「清理对话」后继续。
                </span>
              </div>
            )}

            <form
              className="flex shrink-0 items-center gap-2 border-t border-border p-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleChatSubmit();
              }}
            >
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={contextBlocked ? '上下文已满，请先清理对话' : '输入修改要求…'}
                disabled={busy || !files || contextBlocked}
                className="h-8"
              />
              <Button size="icon-sm" type="submit" disabled={busy || !files || contextBlocked || !prompt.trim()}>
                {agentBusy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              </Button>
            </form>
          </div>
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{files ? '确认重新生成？' : '确认生成网页复刻？'}</DialogTitle>
            <DialogDescription>
              {files
                ? '重新生成会整页替换三个文件。历史对话里的行号会全部失效，因此会一并清空。当前预览保留到新结果生成完成。'
                : '将根据当前切图资产调用 AI 生成 index.html、styles.css、script.js 三个文件，通常需要 30-120 秒。是否开始？'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>取消</Button>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void handleGenerate();
              }}
              disabled={busy}
            >
              确认生成
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认清理对话？</DialogTitle>
            <DialogDescription>
              将删除全部对话历史与上下文计数，已生成的网页文件保留不变。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)}>取消</Button>
            <Button onClick={() => void handleClearConversation()}>确认清理</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 已落盘的一条消息。tool 消息只渲染动作行，工具的原始 JSON 不给用户看。 */
function PersistedMessage({ message }: { message: WebAgentMessage }) {
  if (message.role === 'user') {
    return (
      <div className="ml-6 break-words rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
        {message.text}
      </div>
    );
  }
  if (message.role === 'tool') {
    return (
      <>
        {(message.actions ?? []).map((action, i) => (
          <ActionRow key={i} action={action} />
        ))}
      </>
    );
  }
  return (
    <>
      {message.reasoning && <ThinkingBlock text={message.reasoning} live={false} />}
      {message.text && (
        <div className="mr-6 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
          <AssistantMessageText text={message.text} />
        </div>
      )}
    </>
  );
}
