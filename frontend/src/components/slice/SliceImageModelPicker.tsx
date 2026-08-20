'use client';

// 切图 Tab 内的图片模型选择器。
//
// 闭源版用的是全局 ModelPickerList（内置模型族 + 档位二级菜单），开源版没有
// 「模型族」概念——模型全由用户在设置里自建，所以这里就是一个平铺列表。
//
// 只列 openai 协议的模型：切图的 AI 透明化与背景补齐都要打 /v1/images/edits，
// 背景补齐还要传 mask，Gemini 与 Grok 都没有这个语义。与其让用户选完再收 400，
// 不如在这里就只给出可用项，并在空列表时说清该去配什么。

import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { listSliceImageModels, type SliceImageModel } from '@/lib/slice-model-config';

interface SliceImageModelPickerProps {
  /** 当前选中的 registry 条目 id */
  value: string;
  onSelect: (model: SliceImageModel) => void;
  className?: string;
}

export function SliceImageModelPicker({ value, onSelect, className }: SliceImageModelPickerProps) {
  const models = listSliceImageModels();

  if (models.length === 0) {
    return (
      <div className={cn('p-3 text-xs leading-relaxed text-muted-foreground', className)}>
        还没有可用于切图的图片模型。
        <br />
        请到「设置 → 模型」添加一个 <span className="text-foreground">OpenAI 协议</span>
        的图片模型（如 GPT Image 2）。
        <br />
        <span className="text-[11px] opacity-80">
          Gemini 与 Grok 协议不支持带蒙版的局部编辑，因此不在此列出。
        </span>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {models.map((model) => {
        const active = model.id === value;
        return (
          <button
            key={model.id}
            type="button"
            onClick={() => onSelect(model)}
            className={cn(
              'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted',
              active && 'bg-muted font-medium',
            )}
          >
            <span className="min-w-0 flex-1 truncate">{model.displayName}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{model.modelId}</span>
            {active && <Check className="size-3.5 shrink-0 opacity-70" />}
          </button>
        );
      })}
    </div>
  );
}

/** 触发按钮上的展示名。模型已被删除时退回一句提示而不是空白。 */
export function describeSliceImageModel(modelId: string): string {
  const models = listSliceImageModels();
  if (models.length === 0) return '未配置图片模型';
  return models.find((model) => model.id === modelId)?.displayName
    ?? models[0]?.displayName
    ?? '未配置图片模型';
}
