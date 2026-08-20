// 图片切图数据层类型定义
// 参考 imagetoslice 子项目的切图资产结构，适配主项目 TypeScript + IndexedDB 技术栈。
// 去除 Figma 相关字段，去除 svgData / AI 重绘等非核心字段；
// 图片数据以 Blob key 引用存放在 IndexedDB 的 blobs store，不在此对象内嵌 base64。

/**
 * 切片类型分类（人类可读字符串，沿用字符串以便扩展）。
 * 对应 imagetoslice 中 asset.type 字段。
 */
export type SliceKind =
  | 'manual_slice'
  | 'illustration'
  | 'icon'
  | 'complex-decoration'
  | 'product'
  | 'background'
  | 'text'
  | 'button'
  | 'card'
  | 'navigation'
  | 'other';

/** 切片在源图上的位置与尺寸 */
export interface SlicePlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 四角圆角（像素）。
 * 旧记录只有标量 radius，读取时由 getSliceRadii 推导，因此无需 IndexedDB 迁移。
 */
export interface SliceRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/** 切片来源标记，用于区分手动框选与两类 AI 产出。 */
export type SliceSource = 'manual' | 'ai-asset' | 'ai-background';

/** AI 补齐的双结果角色：局部合成 / 模型原始输出。 */
export type SliceVariantRole = 'composite' | 'raw';

/**
 * 资产处理操作。算法类不消耗额度、可批量；AI 类消耗额度、只允许逐个触发。
 * 与上游 imagetoslice 的四个入口一一对应（透明/AI透明/转SVG/AI重绘SVG）。
 */
export type SliceProcessOp = 'transparent' | 'aiTransparent' | 'svg' | 'aiSvg';

/** 四个操作中属于本地算法、可批量执行的那些。 */
export const BATCHABLE_PROCESS_OPS: readonly SliceProcessOp[] = ['transparent', 'svg'];

/** 该操作是否需要调用 AI（→ 不提供批量入口）。 */
export function isAiProcessOp(op: SliceProcessOp): boolean {
  return op === 'aiTransparent' || op === 'aiSvg';
}

/**
 * 一次处理操作前的可还原快照。
 *
 * 存 Blob key 而非 dataUrl（上游存 dataUrl）：本项目图片一律在 blobs store 里，
 * 快照只记引用，避免把 base64 塞进工作区记录导致 IndexedDB 记录体积失控。
 */
export interface SliceProcessSnapshot {
  /** 操作前的 currentBlobKey，还原时写回 */
  currentBlobKey: string;
  transparent: boolean;
  aiTransparent: boolean;
  /** 操作前的矢量数据；null 表示当时不是 SVG 态 */
  svgData?: string | null;
  svgFromAi?: boolean;
}

/**
 * 单个切片资产。
 * 图片数据不内嵌，通过 Blob key 引用 blobs store 中的记录。
 */
export interface SliceAsset {
  id: string;
  name: string;
  /** SliceKind 的人类可读分类，沿用字符串以便扩展 */
  type: string;
  placement: SlicePlacement;
  radius: number;
  transparent: boolean;
  aiTransparent: boolean;
  aiCompleted: boolean;
  hidden: boolean;
  /** 原始切片图 Blob key */
  originalBlobKey: string;
  /** 当前显示的图片（可能经透明/补齐处理）Blob key */
  currentBlobKey: string;
  /** 透明处理后的 Blob key */
  transparentBlobKey?: string | null;
  /** AI 透明处理后的 Blob key */
  aiTransparentBlobKey?: string | null;

  // ===== v2 新增字段。全部可选，读取旧记录时由下方说明的规则回退，因此无需 IndexedDB 迁移。=====

  /** 四角圆角。缺失时由标量 radius 推导（见 slice-geometry.getSliceRadii）。 */
  radii?: SliceRadii | null;
  /** 来源标记 */
  source?: SliceSource;
  /** AI 识别置信度 [0,1] */
  confidence?: number | null;
  /** AI 给出的判定理由 */
  reason?: string;
  /** 背景类资产中必须保留的内容，写入补齐提示词 */
  bakedVisuals?: string[];
  /** AI 补齐双结果的配对 id（局部合成与 AI 原图共享同一个） */
  aiVariantGroupId?: string;
  /** 在双结果中的角色 */
  aiVariantRole?: SliceVariantRole;
  /** 锁定后移动不触发重裁剪（保护已有 AI 结果） */
  locked?: boolean;
  /** 本地边缘混合补丁 Blob key，用于「挖洞」查看模式 */
  repairBlobKey?: string | null;

  // ===== v3 新增：矢量化与逐操作还原。同样是可选字段 + 读取时回退，无需 IndexedDB 迁移。=====

  /**
   * 矢量数据（SVG 源码文本）。
   * 存文本而非 Blob：导出要写 .svg、HTML 复刻可能要内联，都需要原文；
   * 且单个图标 SVG 通常只有几 KB，进工作区记录没有体积压力。
   */
  svgData?: string | null;
  /** svgData 是 AI 重绘产出（true）还是本地算法矢量化产出（false）。 */
  svgFromAi?: boolean;
  /** 逐操作的还原快照。四个操作各自独立，互不覆盖。 */
  processSnapshots?: Partial<Record<SliceProcessOp, SliceProcessSnapshot>> | null;
  /**
   * 已就该资产的破坏性调整征询过用户（见 A7 确认弹窗）。
   * 只在会话内有意义，落盘无害。
   */
  processResetConfirmed?: boolean;
}

/** 源图屏幕尺寸 */
export interface SliceScreen {
  width: number;
  height: number;
}

/**
 * 网页复刻 agent 的一条消息。
 * 注意 reasoning 只用于 UI 思考块回显：它是输出侧内容，下一轮请求不回传，
 * 因此不占上下文预算（预算一律以 API 返回的 input_tokens 为准）。
 */
export interface WebAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text?: string;
  reasoning?: string;
  reasoningMs?: number;
  toolCalls?: { callId: string; name: string; argumentsJson: string }[];
  toolResults?: { callId: string; name: string; output: string }[];
  /** UI 展示用的动作摘要，如「已阅读 styles.css（1-142 行）」 */
  actions?: { kind: 'read' | 'edit'; path: string; summary: string; ok: boolean }[];
  createdAt: string;
}

/** 供应商回报的 token 用量快照，供头部 hover 展示明细 */
export interface WebAgentUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

/**
 * 切图工作区草稿（对应 IndexedDB workspaces store 中的一条记录）。
 */
export interface SliceWorkspaceDraft {
  id: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  screen: SliceScreen;
  /** 原始源图 Blob key */
  sourceImageBlobKey: string;
  /** 缩略图 Blob key（可选） */
  thumbnailBlobKey?: string | null;
  assets: SliceAsset[];
  /**
   * @deprecated 旧的单文件产物。读取时由 resolveReplicaFiles 自动拆成 replicaFiles，
   * 因此无需 IndexedDB 迁移（沿用本文件 v2 字段的「可选字段 + 读取时回退」惯例）。
   */
  reconstructedHtml?: string | null;
  /** 网页复刻的三文件产物（index.html / styles.css / script.js） */
  replicaFiles?: { 'index.html': string; 'styles.css': string; 'script.js': string } | null;
  /** 网页复刻 agent 的对话历史 */
  webAgentMessages?: WebAgentMessage[] | null;
  /** 最近一次请求 API 报告的 input_tokens，即当前上下文大小；null = 尚未发过请求 */
  webAgentContextTokens?: number | null;
  /** 最近一次 usage 明细 */
  webAgentLastUsage?: WebAgentUsageSnapshot | null;
}

/**
 * localStorage 设置（图片模型选择）。
 * 注意：不 import ModelId 以避免耦合，用 string 即可。
 */
export interface SliceSettings {
  /** ModelId */
  model: string;
  useTokenMode: boolean;
}
