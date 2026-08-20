// 网页复刻 agent 的固定前缀构建。
//
// 关键设计：前缀**每轮请求重新构建**，不存进对话历史。
// 这样带来三件事：
//   1. 切图资源永远在场——多轮对话下去 agent 不会"忘了图片长什么样"
//   2. 用户在拆图页增删切片后，agent 下一轮立刻看到新状态，不会拿着过期清单干活
//   3. 持久化的历史里只有文本和工具调用，不存 base64，IndexedDB 不会被图片撑爆

import type { NovaAgentRequestMessage } from '@/lib/nova-agent-protocol';
import type { SliceWorkspaceDraft } from '@/lib/slice-types';
import { describeReplicaFiles, REPLICA_FILE_PATHS, type ReplicaFiles } from './vfs';

export interface AssetBrief {
  id: string;
  name: string;
  kind: string;
  placement: { x: number; y: number; width: number; height: number };
}

function describeAssets(assets: AssetBrief[]): string {
  if (!assets.length) return '（当前没有切图资产）';
  return assets
    .map((asset) => {
      const p = asset.placement;
      return `- asset:${asset.id} · ${asset.name || '未命名'} · ${asset.kind} · 位于源图 x=${Math.round(p.x)}, y=${Math.round(p.y)}, w=${Math.round(p.width)}, h=${Math.round(p.height)}`;
    })
    .join('\n');
}

export function buildWebAgentSystemPrompt(params: {
  files: ReplicaFiles;
  assets: AssetBrief[];
  screen: { width: number; height: number };
}): string {
  const { files, assets, screen } = params;
  return [
    '你是一名前端工程师，正在维护一个由 UI 截图复刻而来的网页。',
    '',
    '## 文件系统',
    '固定为以下三个可写文件，外加一个只读的 assets/ 图片目录。',
    '**不能新建文件，不能删除文件，也没有对应的工具。**',
    describeReplicaFiles(files),
    '- assets/ —— 只读。在 HTML 里用 <img data-reference-asset="<id>" src="asset:<id>"> 引用。',
    '',
    `页面画板尺寸固定为 ${Math.round(screen.width)}×${Math.round(screen.height)}px，根容器是 .screen。`,
    'index.html 通过 <link rel="stylesheet" href="./styles.css"> 和 <script src="./script.js" defer></script> 引用另外两个文件，不要改动这两行，也不要往 index.html 里写行内 <style> 或 style="" 。',
    '',
    '## 切图资产',
    '随本条消息附带了两张图：原始截图，以及全部切图资产的总览图（每格下方标注了它的 id 和名称）。',
    '这些是你复刻的依据，每轮都会重新提供，可以随时对照。',
    describeAssets(assets),
    '',
    '## 工作方式',
    `1. 动手前先用 read_file 确认当前内容和行号。你只有 ${REPLICA_FILE_PATHS.join(' / ')} 这三个文件。`,
    '2. 用 edit_file 按行改动，**只提交要改的那几行，不要重发整个文件**。',
    '3. 一次 edit_file 可以带多处编辑，它们的行号都基于当前文件，你不需要自己算偏移。',
    '4. 尽量带上 expectFirstLine：行号数错时编辑会被拒绝，而不是把文件改坏。',
    '5. 编辑结果会回给你改动区域的实际内容，和预期不符就据此修正。',
    '6. 改动涉及样式就改 styles.css，涉及结构就改 index.html，涉及交互就改 script.js。',
    '7. 全部改完后，用一两句中文说明你做了什么。不要复述代码。',
    '',
    '## 约束',
    '- 保持与原截图的视觉一致，除非用户明确要求改变外观。',
    '- 不要移除或替换切图资产的 <img> 锚点，也不要改动它们的 data-reference-asset。',
    '- 不使用外部 URL、网络字体、网络请求。script.js 只做本地 DOM 交互。',
    '- 用户用中文提问就用中文回答。',
  ].join('\n');
}

/**
 * 构建固定前缀：系统提示 + 源截图 + 资产总览图。
 * contactSheetDataUrl 为 null 时（无资产或 canvas 不可用）自动省略，不影响请求。
 */
export function buildPinnedPrefix(params: {
  systemPrompt: string;
  sourceImageDataUrl: string | null;
  contactSheetDataUrl: string | null;
}): NovaAgentRequestMessage[] {
  const { systemPrompt, sourceImageDataUrl, contactSheetDataUrl } = params;
  const messages: NovaAgentRequestMessage[] = [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
  ];

  const attachments: NovaAgentRequestMessage['content'] = [];
  if (sourceImageDataUrl) {
    attachments.push({ type: 'text', text: '【原始截图】复刻的唯一依据：' });
    attachments.push({ type: 'image', imageDataUrl: sourceImageDataUrl });
  }
  if (contactSheetDataUrl) {
    attachments.push({
      type: 'text',
      text: '【切图资产总览】每格下方是该资产的 id 与名称，在 HTML 中用 asset:<id> 引用：',
    });
    attachments.push({ type: 'image', imageDataUrl: contactSheetDataUrl });
  }
  if (attachments.length) {
    messages.push({ role: 'user', content: attachments });
  }

  return messages;
}

export function toAssetBriefs(workspace: SliceWorkspaceDraft): AssetBrief[] {
  return workspace.assets
    .filter((asset) => !asset.hidden)
    .map((asset) => ({
      id: asset.id,
      name: asset.name || asset.id,
      kind: asset.type,
      placement: { ...asset.placement },
    }));
}
