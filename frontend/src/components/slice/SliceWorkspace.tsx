'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Code2,
  Copy,
  Download,
  FolderOpen,
  ImagePlus,
  PanelLeftOpen,
  Pencil,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react';

import { AgentAssetPickerDialog } from '@/components/agent/AgentAssetPickerDialog';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { getAssetBlob, type ImageAsset } from '@/lib/asset-store';
import { getBlob } from '@/lib/slice-db';
import { describeSourceImageSizeError } from '@/lib/slice-geometry';
import {
  collectHydratedAssets,
  exportReplicaZip,
  resolveReplicaFiles,
} from '@/lib/slice-reconstruct';
import {
  exportFullPackage,
  exportSlicePackage,
  importSliceWorkspacePackage,
} from '@/lib/slice-export';
import type { SliceWorkspaceDraft } from '@/lib/slice-types';
import { SliceEditor } from './SliceEditor';
import { WebReplicaWorkspace } from './WebReplicaWorkspace';
import { useSliceStore } from './stores/use-slice-store';

type SliceWorkspaceProps = {
  wideMode?: boolean;
  onConfigureApiKey: () => void;
  onEnableWideMode: () => void;
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
};

// 读取图片宽高，用于 createWorkspace 的 screen 参数。
// 本地文件与素材 Blob 共用此逻辑，保证尺寸来源一致。
async function readImageDimensions(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof document === 'undefined') return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('图片读取失败'));
      el.src = url;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) return null;
    return { width, height };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function SliceWorkspace({ wideMode, onConfigureApiKey, onEnableWideMode, showToast }: SliceWorkspaceProps) {
  const hydrated = useSliceStore((s) => s.hydrated);
  const workspaces = useSliceStore((s) => s.workspaces);
  const activeWorkspaceId = useSliceStore((s) => s.activeWorkspaceId);
  const hydrate = useSliceStore((s) => s.hydrate);
  const createWorkspace = useSliceStore((s) => s.createWorkspace);
  const openWorkspace = useSliceStore((s) => s.openWorkspace);
  const closeWorkspace = useSliceStore((s) => s.closeWorkspace);
  const deleteWorkspace = useSliceStore((s) => s.deleteWorkspace);
  const copyWorkspace = useSliceStore((s) => s.copyWorkspace);
  const updateWorkspaceNote = useSliceStore((s) => s.updateWorkspaceNote);
  const updateActiveWorkspace = useSliceStore((s) => s.updateActiveWorkspace);
  const activeWorkspace = useSliceStore((s) => s.activeWorkspace);

  const [mounted, setMounted] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // 创建中禁用素材项，避免重复提交（创建完成后会自动跳转编辑器）。
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const packageInputRef = useRef<HTMLInputElement>(null);
  // 工作区内的子 tab：图片拆图在左，网页复刻在右（拆图是网页复刻的前置步骤）。
  const [activeSubTab, setActiveSubTab] = useState<'slice' | 'web-replica'>('slice');
  const [subTabBusy, setSubTabBusy] = useState(false);
  const previousWorkspaceId = useRef<string | null>(null);

  // 切换工作区时重置到「图片拆图」子 tab，保留原有的切图优先入口。
  useEffect(() => {
    if (previousWorkspaceId.current !== activeWorkspaceId) {
      previousWorkspaceId.current = activeWorkspaceId;
      setActiveSubTab('slice');
      setSubTabBusy(false);
    }
  }, [activeWorkspaceId]);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // 本地图片上传：读取宽高后创建工作区，返回的 id 自动设为 active，编辑器显示。
  const handleLocalFile = async (file: File) => {
    try {
      const dims = await readImageDimensions(file);
      if (!dims) {
        showToast('无法读取图片，请确认是有效的图片文件', 'error');
        return;
      }
      const sizeError = describeSourceImageSizeError(dims.width, dims.height);
      if (sizeError) {
        showToast(sizeError, 'error');
        return;
      }
      await createWorkspace(file, dims);
    } catch {
      showToast('创建工作区失败，请稍后重试', 'error');
    }
  };

  // 从素材库选择：复用全站素材选择器，只负责把选中的素材接入切图工作区。
  const handlePickAsset = async (asset: ImageAsset) => {
    setBusy(true);
    try {
      const blob = await getAssetBlob(asset.id);
      if (!blob) {
        showToast('素材读取失败', 'error');
        return;
      }
      const dims = await readImageDimensions(blob);
      if (!dims) {
        showToast('无法读取图片尺寸', 'error');
        return;
      }
      const sizeError = describeSourceImageSizeError(dims.width, dims.height);
      if (sizeError) {
        showToast(sizeError, 'error');
        return;
      }
      await createWorkspace(blob, dims);
      setAssetPickerOpen(false);
    } catch {
      showToast('创建工作区失败，请稍后重试', 'error');
    } finally {
      setBusy(false);
    }
  };

  // 导入完整包或切图包。导入后使用当前工作区更新入口写入切图与历史网页结果。
  const handleImportPackage = async (file: File) => {
    setBusy(true);
    try {
      const imported = await importSliceWorkspacePackage(file);
      await createWorkspace(imported.sourceBlob, imported.screen);
      const created = useSliceStore.getState().activeWorkspace;
      if (!created) throw new Error('导入工作区创建失败');
      await updateActiveWorkspace((draft) => {
        draft.note = imported.note;
        draft.assets = imported.assets;
        draft.replicaFiles = imported.replicaFiles;
        draft.reconstructedHtml = null;
        // 工作区列表直接显示源图的模糊缩略图，避免导入后卡片没有预览。
        draft.thumbnailBlobKey = draft.sourceImageBlobKey || null;
      });
      showToast(
        imported.replicaFiles ? '完整包已导入，历史网页结果已恢复' : '切图包已导入',
        'success',
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导入包失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  type ExportKind = 'slice' | 'web' | 'full';
  const handleExport = async (kind: ExportKind) => {
    const ws = useSliceStore.getState().activeWorkspace;
    if (!ws) return;
    const visibleAssets = ws.assets.filter((asset) => !asset.hidden);
    if (visibleAssets.length === 0) {
      showToast('当前没有已完成的切图，无法导出', 'error');
      return;
    }
    const incompleteAiAsset = visibleAssets.find(
      (asset) => asset.source === 'ai-background' && !asset.aiCompleted,
    );
    if (incompleteAiAsset) {
      showToast(`AI 背景“${incompleteAiAsset.name || '未命名'}”生成未完成，无法导出`, 'error');
      return;
    }
    if (visibleAssets.some((asset) => !asset.currentBlobKey)) {
      showToast('部分切图数据缺失，疑似 AI 切图失败，请修复后再导出', 'error');
      return;
    }
    if ((kind === 'web' || kind === 'full') && !resolveReplicaFiles(ws)?.['index.html'].trim()) {
      showToast('网页复刻尚未成功生成，无法导出', 'error');
      return;
    }

    setExportBusy(true);
    try {
      if (kind === 'slice') {
        await exportSlicePackage(ws);
        showToast('切图包已导出', 'success');
      } else {
        const hydratedAssets = await collectHydratedAssets(ws);
        if (hydratedAssets.length !== visibleAssets.length) {
          throw new Error('部分切图数据缺失，疑似 AI 切图失败，请修复后再导出');
        }
        if (kind === 'web') {
          exportReplicaZip(resolveReplicaFiles(ws)!, hydratedAssets, ws.note);
          showToast('网页内容已导出', 'success');
        } else {
          await exportFullPackage(ws, hydratedAssets);
          showToast('完整包已导出', 'success');
        }
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '导出失败', 'error');
    } finally {
      setExportBusy(false);
    }
  };

  // 切图仅在宽屏模式下可用（与无限画布一致），以降低适配成本。
  if (!wideMode) {
    return (
      <div className="grid place-items-center rounded-2xl border border-dashed border-border py-20">
        <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          <Scissors className="size-10 text-muted-foreground" />
          <h2 className="text-base font-semibold">UI设计模式需要宽屏模式</h2>
          <p className="text-sm text-muted-foreground">请使用电脑，或切换到宽屏模式（窗口宽度需 ≥ 1280px）。</p>
          <Button size="sm" onClick={onEnableWideMode}>
            <PanelLeftOpen className="size-4" />
            切换宽屏模式
          </Button>
        </div>
      </div>
    );
  }

  if (activeWorkspaceId) {
    const visibleAssets = activeWorkspace?.assets.filter((asset) => !asset.hidden) ?? [];
    const hasIncompleteAiAsset = visibleAssets.some(
      (asset) => asset.source === 'ai-background' && !asset.aiCompleted,
    );
    const hasMissingAssetBlob = visibleAssets.some((asset) => !asset.currentBlobKey);
    const canExportSlice =
      !subTabBusy && visibleAssets.length > 0 && !hasIncompleteAiAsset && !hasMissingAssetBlob;
    const canExportWeb =
      !subTabBusy &&
      Boolean(resolveReplicaFiles(activeWorkspace)?.['index.html'].trim()) &&
      !hasIncompleteAiAsset &&
      !hasMissingAssetBlob;
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        {/* 工作区工具栏：返回入口与子 tab 固定在同一位置，两个页面切换时不再跳动。 */}
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={closeWorkspace}>
            <ArrowLeft className="size-4" />
            返回
          </Button>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-1">
            <Button
              size="sm"
              variant={activeSubTab === 'slice' ? 'default' : 'ghost'}
              onClick={() => setActiveSubTab('slice')}
              disabled={subTabBusy}
              title={subTabBusy ? '当前任务进行中，完成后可切换' : '切换到图片拆图'}
            >
              <Scissors className="size-4" />
              图片拆图
            </Button>
            <Button
              size="sm"
              variant={activeSubTab === 'web-replica' ? 'default' : 'ghost'}
              onClick={() => setActiveSubTab('web-replica')}
              disabled={subTabBusy}
              title={subTabBusy ? '当前任务进行中，完成后可切换' : '切换到网页复刻'}
            >
              <Code2 className="size-4" />
              网页复刻
            </Button>
          </div>
          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
                disabled={exportBusy}
                title="导出切图包、网页或完整包"
              >
                <Download className="size-4" />
                导出
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!canExportSlice || exportBusy}
                  onClick={() => void handleExport('slice')}
                >
                  导出切图包
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canExportWeb || exportBusy}
                  onClick={() => void handleExport('web')}
                >
                  导出网页
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canExportWeb || exportBusy}
                  onClick={() => void handleExport('full')}
                >
                  全部导出
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {activeSubTab === 'slice' ? (
            <SliceEditor
              workspaceId={activeWorkspaceId}
              onConfigureApiKey={onConfigureApiKey}
              showToast={showToast}
              onTaskStateChange={setSubTabBusy}
            />
          ) : (
            <WebReplicaWorkspace
              onConfigureApiKey={onConfigureApiKey}
              showToast={showToast}
              onTaskStateChange={setSubTabBusy}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">UI设计模式</h2>
          <p className="text-xs text-muted-foreground">AI 拆解 UI 图为切图资产 · 手动校准 · 网页复刻</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleLocalFile(file);
              event.target.value = '';
            }}
          />
          <input
            ref={packageInputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImportPackage(file);
              event.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busy}>
            <Upload className="size-4" />
            本地图片
          </Button>
          <Button variant="outline" size="sm" onClick={() => packageInputRef.current?.click()} disabled={busy}>
            <Upload className="size-4" />
            导入包
          </Button>
          <Button size="sm" onClick={() => setAssetPickerOpen(true)} disabled={busy}>
            <ImagePlus className="size-4" />
            从素材库导入
          </Button>
        </div>
      </div>

      {!mounted || !hydrated ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-border py-16 text-sm text-muted-foreground">
          加载中…
        </div>
      ) : workspaces.length === 0 ? (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-16 text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <Scissors className="size-8" />
          开始新工作
          <span className="text-xs">上传一张 UI 图或从素材中选择开始切图</span>
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((workspace) => (
            <WorkspaceCard
              key={workspace.id}
              workspace={workspace}
              onOpen={() => void openWorkspace(workspace.id)}
              onCopy={() => void copyWorkspace(workspace.id)}
              onRename={(note) => void updateWorkspaceNote(workspace.id, note)}
              onDelete={() => setDeleteId(workspace.id)}
            />
          ))}
        </div>
      )}

      {/* 复用全站素材库选择器，保持搜索、标签筛选和虚拟列表体验一致。 */}
      <AgentAssetPickerDialog
        open={assetPickerOpen}
        maxSelected={1}
        onOpenChange={setAssetPickerOpen}
        onConfirm={(assets) => {
          const asset = assets[0];
          if (asset) void handlePickAsset(asset);
        }}
      />

      {/* 删除确认对话框 */}
      <Dialog open={Boolean(deleteId)} onOpenChange={(open) => !open && setDeleteId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>删除 UI 设计工作区</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">删除后无法恢复（源图与切图也会从本地清理）。确定删除该工作区吗？</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteId) void deleteWorkspace(deleteId);
                setDeleteId(null);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 工作区卡片：缩略图、备注、切图数量、操作按钮。 */
function WorkspaceCard({
  workspace,
  onOpen,
  onCopy,
  onRename,
  onDelete,
}: {
  workspace: SliceWorkspaceDraft;
  onOpen: () => void;
  onCopy: () => void;
  onRename: (note: string) => void;
  onDelete: () => void;
}) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [noteInput, setNoteInput] = useState('');

  // 加载缩略图 objectURL，卸载或 thumbnailBlobKey 变更时 revoke。
  useEffect(() => {
    let active = true;
    let created: string | null = null;
    const key = workspace.thumbnailBlobKey || workspace.sourceImageBlobKey;
    if (!key) return;
    void getBlob(key).then((blob) => {
      if (!active || !blob) return;
      created = URL.createObjectURL(blob);
      setThumbUrl(created);
    });
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [workspace.thumbnailBlobKey, workspace.sourceImageBlobKey]);

  const startEdit = () => {
    setNoteInput(workspace.note ?? '');
    setEditing(true);
  };

  const commitEdit = () => {
    setEditing(false);
    const next = noteInput.trim();
    if (next && next !== workspace.note) onRename(next);
  };

  const cancelEdit = () => {
    setEditing(false);
    setNoteInput(workspace.note ?? '');
  };

  return (
    <div className="group flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm transition-colors hover:border-primary/40">
      <button
        type="button"
        aria-label="打开 UI 设计工作区"
        className="relative block aspect-video w-full overflow-hidden rounded-lg bg-background"
        onClick={onOpen}
      >
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt={workspace.note || 'UI 设计预览'}
            className="size-full scale-105 object-cover blur-sm opacity-85"
          />
        ) : (
          <div className="grid size-full place-items-center text-muted-foreground">
            <Scissors className="size-6" />
          </div>
        )}
        {thumbUrl && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-background/25"
            style={{ boxShadow: 'inset 0 0 28px 10px var(--background)' }}
          />
        )}
      </button>

      {editing ? (
        <Input
          autoFocus
          value={noteInput}
          onChange={(event) => setNoteInput(event.target.value)}
          onBlur={commitEdit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitEdit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              cancelEdit();
            }
          }}
        />
      ) : (
        <button
          type="button"
          title="双击编辑备注"
          className="w-full rounded-md text-left transition-colors hover:text-primary"
          onDoubleClick={startEdit}
        >
          <span className="line-clamp-1 font-medium">{workspace.note?.trim() || '未命名工作'}</span>
        </button>
      )}

      <p className="text-xs text-muted-foreground">
        {workspace.assets.length} 个切图 ·{' '}
        {new Date(workspace.updatedAt).toLocaleString('zh-CN', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </p>

      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" className="flex-1" onClick={onOpen}>
          <FolderOpen className="size-4" />
          打开
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="编辑备注" onClick={startEdit}>
          <Pencil className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="创建副本" onClick={onCopy}>
          <Copy className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="删除" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}
