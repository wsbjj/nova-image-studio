// 网页复刻 agent 的工具定义与执行器。
//
// 只有两个工具：读文件、按行编辑文件。
// 刻意没有「新建文件」「删除文件」——文件系统固定为三个文本文件 + 只读 assets/，
// 模型不能扩张自己的操作面，预览也就永远加载得到所有引用。

import type { NovaAgentToolDef } from '@/lib/nova-agent-protocol';
import {
  applyEdits,
  isReplicaFilePath,
  readLines,
  REPLICA_FILE_PATHS,
  type LineEdit,
  type ReplicaFilePath,
  type ReplicaFiles,
} from './vfs';

export const WEB_AGENT_TOOLS: NovaAgentToolDef[] = [
  {
    name: 'read_file',
    description:
      '读取一个文件的内容，返回带行号的文本。行号从 1 开始、首尾都含。' +
      '不传 startLine/endLine 则读全文（最多 400 行）。编辑前务必先读，确认行号。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          enum: [...REPLICA_FILE_PATHS],
          description: '要读取的文件',
        },
        startLine: { type: ['integer', 'null'], description: '起始行号（1-based，含）' },
        endLine: { type: ['integer', 'null'], description: '结束行号（1-based，含）' },
      },
      required: ['path', 'startLine', 'endLine'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_file',
    description:
      '按行替换文件内容。只提交要改动的行，不要重发整个文件。' +
      '一次调用可以包含多处编辑，它们的行号都基于当前文件（不必自己计算偏移）。' +
      '纯插入用 endLine = startLine - 1；删除用 content = ""。' +
      '强烈建议带上 expectFirstLine 做校验：行号数错时会被拒绝，而不是改坏文件。',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          enum: [...REPLICA_FILE_PATHS],
          description: '要编辑的文件',
        },
        edits: {
          type: 'array',
          description: '本次要应用的编辑，区间不得重叠',
          items: {
            type: 'object',
            properties: {
              startLine: { type: 'integer', description: '起始行号（1-based，含）' },
              endLine: {
                type: 'integer',
                description: '结束行号（1-based，含）。纯插入时填 startLine - 1',
              },
              content: { type: 'string', description: '替换文本。空串表示删除该区间' },
              expectFirstLine: {
                type: ['string', 'null'],
                description: '期望 startLine 那一行的内容，用于防止行号漂移',
              },
            },
            required: ['startLine', 'endLine', 'content', 'expectFirstLine'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
  },
];

export interface ToolExecution {
  /** 回传给模型的 JSON 字符串 */
  output: string;
  /** 工具执行后的文件状态（read 时与入参相同） */
  files: ReplicaFiles;
  ok: boolean;
  kind: 'read' | 'edit';
  path: string;
  /** UI 动作行文案，如「已编辑 styles.css（12-18 行 → 6 行）」 */
  summary: string;
}

function fail(kind: 'read' | 'edit', path: string, error: string, files: ReplicaFiles): ToolExecution {
  return {
    output: JSON.stringify({ ok: false, error }),
    files,
    ok: false,
    kind,
    path,
    summary: error,
  };
}

function parseArgs(argumentsJson: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argumentsJson || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function optionalInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/**
 * 执行一次工具调用。纯函数式：不修改入参，返回新的 files。
 *
 * 任何失败都返回结构化的 ok:false + error，而不是抛异常——
 * 模型需要读到失败原因才能自己纠正，抛异常只会中断整个循环。
 */
export function executeWebAgentTool(
  name: string,
  argumentsJson: string,
  files: ReplicaFiles,
): ToolExecution {
  const kind: 'read' | 'edit' = name === 'edit_file' ? 'edit' : 'read';

  const args = parseArgs(argumentsJson);
  if (!args) return fail(kind, '', '工具参数不是合法 JSON', files);

  const rawPath = String(args.path ?? '');
  if (!isReplicaFilePath(rawPath)) {
    return fail(
      kind,
      rawPath,
      `未知文件 ${JSON.stringify(rawPath)}。文件系统固定为 ${REPLICA_FILE_PATHS.join(' / ')} ` +
        '三个文件加只读的 assets/ 目录，不能新建或删除文件。',
      files,
    );
  }
  const path: ReplicaFilePath = rawPath;

  if (name === 'read_file') {
    const result = readLines(path, files[path], optionalInt(args.startLine), optionalInt(args.endLine));
    return {
      output: JSON.stringify({
        ok: true,
        path,
        totalLines: result.totalLines,
        startLine: result.startLine,
        endLine: result.endLine,
        truncated: result.truncated,
        ...(result.truncated
          ? { note: '内容过长已截断，请用 startLine/endLine 继续读取剩余部分' }
          : {}),
        content: result.text,
      }),
      files,
      ok: true,
      kind: 'read',
      path,
      summary:
        result.totalLines === 0
          ? `已阅读 ${path}（空文件）`
          : `已阅读 ${path}（${result.startLine}-${result.endLine} 行，共 ${result.totalLines} 行）`,
    };
  }

  if (name === 'edit_file') {
    if (!Array.isArray(args.edits)) {
      return fail('edit', path, 'edits 必须是数组', files);
    }
    const edits: LineEdit[] = (args.edits as Record<string, unknown>[]).map((raw) => ({
      startLine: Number(raw?.startLine),
      endLine: Number(raw?.endLine),
      content: typeof raw?.content === 'string' ? raw.content : '',
      ...(typeof raw?.expectFirstLine === 'string' && raw.expectFirstLine
        ? { expectFirstLine: raw.expectFirstLine }
        : {}),
    }));

    const result = applyEdits(files[path], edits);
    if (!result.ok) return fail('edit', path, result.error, files);

    const first = result.changed[0];
    const range = result.changed.length === 1 && first
      ? `${first.oldStart}-${first.oldEnd} 行 → ${first.inserted} 行`
      : `${result.changed.length} 处改动`;

    return {
      output: JSON.stringify({
        ok: true,
        path,
        totalLines: result.totalLines,
        changed: result.changed.map((c) => ({
          oldStart: c.oldStart,
          oldEnd: c.oldEnd,
          newStart: c.newStart,
          newEnd: c.newEnd,
        })),
        note: '以下是改动后的实际内容（含上下文），若与预期不符请据此修正',
        preview: result.preview,
      }),
      files: { ...files, [path]: result.content },
      ok: true,
      kind: 'edit',
      path,
      summary: `已编辑 ${path}（${range}）`,
    };
  }

  return fail(kind, path, `未知工具 ${name}`, files);
}
