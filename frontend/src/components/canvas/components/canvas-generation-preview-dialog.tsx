"use client";

import { Copy, Image as ImageIcon, Route, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { NodeGenerationContext } from "./canvas-node-generation";
import type { CanvasGenerationConfig, CanvasNodeData } from "../types";

export function CanvasGenerationPreviewDialog({
  open,
  onOpenChange,
  node,
  context,
  config,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: CanvasNodeData | null;
  context: NodeGenerationContext | null;
  config: CanvasGenerationConfig | null;
  onCopy: (text: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>生成预览</DialogTitle>
        </DialogHeader>
        {node && context && config && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <PreviewMeta icon={<Route />} label="提示词路线" value={context.route?.label || "手动编排"} />
              <PreviewMeta icon={<ImageIcon />} label="引用资源" value={`${context.textCount} 段文本 / ${context.imageCount} 张图片`} />
              <PreviewMeta icon={<Settings2 />} label="生成参数" value={`${config.model} · ${config.outputSize} · ${config.aspectRatio} · ${config.count} 张`} />
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{node.title} · 最终提示词</span>
                <Button variant="outline" size="xs" onClick={() => onCopy(context.prompt)}>
                  <Copy className="size-3.5" />
                  复制
                </Button>
              </div>
              <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">{context.prompt || "（提示词为空）"}</pre>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export type CanvasBatchPreviewItem = {
  node: CanvasNodeData;
  valid: boolean;
  reason?: string;
  imageCount: number;
};

export function CanvasBatchGenerationDialog({
  open,
  onOpenChange,
  items,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CanvasBatchPreviewItem[];
  onConfirm: () => void;
}) {
  const validItems = items.filter((item) => item.valid);
  const totalImages = validItems.reduce((sum, item) => sum + item.imageCount, 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>批量生成</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm">已选择 {items.length} 个配置，其中 {validItems.length} 个可生成，预计生成 {totalImages} 张图片。</p>
          <div className="max-h-64 space-y-1 overflow-auto rounded-md border border-border p-2">
            {items.map((item) => (
              <div key={item.node.id} className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-xs">
                <span className="min-w-0 truncate font-medium">{item.node.title}</span>
                <span className={item.valid ? "shrink-0 text-muted-foreground" : "shrink-0 text-destructive"}>{item.valid ? `${item.imageCount} 张` : item.reason}</span>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button disabled={!validItems.length} onClick={onConfirm}>开始生成 {validItems.length} 个配置</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewMeta({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border p-2">
      <span className="mb-1 flex items-center gap-1 text-muted-foreground [&_svg]:size-3.5">{icon}{label}</span>
      <span className="block truncate font-medium" title={value}>{value}</span>
    </div>
  );
}
