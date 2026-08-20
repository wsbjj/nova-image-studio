// 网页复刻 agent 的虚拟文件系统。
//
// 文件系统固定为三个可写文本文件 + 只读 assets/ 目录，不支持新建或删除。
// 这样 agent 的编辑面永远已知，不会凭空造出预览加载不到的文件。
//
// 行号一律 1-based 且首尾都含，与 read_file 回给模型的带号文本完全一致——
// 模型看到的行号就是它能写回来的行号，中间不做任何偏移换算。

export const REPLICA_FILE_PATHS = ['index.html', 'styles.css', 'script.js'] as const;

export type ReplicaFilePath = (typeof REPLICA_FILE_PATHS)[number];

export type ReplicaFiles = Record<ReplicaFilePath, string>;

/** 单次 read_file 返回的最大行数。超出时截断，并提示模型按区间续读。 */
export const MAX_READ_LINES = 400;

/** 编辑回报里改动区域上下各带几行上下文，供模型自校正。 */
const PREVIEW_CONTEXT_LINES = 3;

export function isReplicaFilePath(value: unknown): value is ReplicaFilePath {
  return typeof value === 'string' && (REPLICA_FILE_PATHS as readonly string[]).includes(value);
}

export function createEmptyReplicaFiles(): ReplicaFiles {
  return { 'index.html': '', 'styles.css': '', 'script.js': '' };
}

/**
 * 拆行。统一 CRLF 为 LF，空串得到 0 行。
 *
 * 内容以 \n 结尾时，末尾会多出一个空字符串元素（"a\nb\n" → ['a','b','']）。
 * 这是刻意的：fromLines(toLines(x)) === x 必须严格成立，宁可行数看着多一行，
 * 也不能在编辑往返中悄悄吃掉结尾换行——那种丢失累积几轮之后极难排查。
 */
export function toLines(content: string): string[] {
  const normalized = String(content ?? '').replace(/\r\n/g, '\n');
  return normalized.length === 0 ? [] : normalized.split('\n');
}

export function fromLines(lines: string[]): string {
  return lines.join('\n');
}

export function countLines(content: string): number {
  return toLines(content).length;
}

/** 给一段行加上右对齐行号，形如 `  12| .title {` */
function numberLines(lines: string[], startLine: number): string {
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}| ${line}`)
    .join('\n');
}

export interface ReadResult {
  path: ReplicaFilePath;
  startLine: number;
  endLine: number;
  totalLines: number;
  /** 是否因为超过 MAX_READ_LINES 被截断 */
  truncated: boolean;
  /** 带行号的文本 */
  text: string;
}

/**
 * 读取指定行区间，返回带行号的文本。
 * 区间越界会被夹紧而不是报错——读取是只读操作，纠正比拒绝更有用。
 */
export function readLines(
  path: ReplicaFilePath,
  content: string,
  start?: number,
  end?: number,
): ReadResult {
  const lines = toLines(content);
  const totalLines = lines.length;

  if (totalLines === 0) {
    return { path, startLine: 0, endLine: 0, totalLines: 0, truncated: false, text: '' };
  }

  const rawStart = Number.isFinite(start) ? Math.trunc(start as number) : 1;
  const rawEnd = Number.isFinite(end) ? Math.trunc(end as number) : totalLines;

  const startLine = Math.min(Math.max(rawStart, 1), totalLines);
  let endLine = Math.min(Math.max(rawEnd, startLine), totalLines);

  let truncated = false;
  if (endLine - startLine + 1 > MAX_READ_LINES) {
    endLine = startLine + MAX_READ_LINES - 1;
    truncated = true;
  }

  const slice = lines.slice(startLine - 1, endLine);
  return { path, startLine, endLine, totalLines, truncated, text: numberLines(slice, startLine) };
}

export interface LineEdit {
  /** 1-based，含 */
  startLine: number;
  /** 1-based，含；等于 startLine - 1 表示在 startLine 前纯插入 */
  endLine: number;
  /** 替换文本。空串表示删除该区间。 */
  content: string;
  /** 可选防漂移校验：期望 startLine 那一行的内容（比较时两侧都 trim） */
  expectFirstLine?: string;
}

export interface AppliedEditRange {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  removed: number;
  inserted: number;
}

export type ApplyEditsResult =
  | {
      ok: true;
      content: string;
      totalLines: number;
      changed: AppliedEditRange[];
      /** 改动区域 ±3 行的带号文本，回传给模型自校正 */
      preview: string;
    }
  | { ok: false; error: string };

/**
 * 批量按行编辑。
 *
 * 三条硬规则，任何一条不满足都整批拒绝、不做部分应用：
 * 1. 行号必须是整数且落在 [1, totalLines]（末尾追加可用 startLine = totalLines + 1）
 * 2. 多个编辑的区间不得重叠，也不允许两个插入落在同一位置（顺序无法确定）
 * 3. 给了 expectFirstLine 就必须对得上
 *
 * 部分应用是这里最危险的失败模式：模型以为改了一半，实际文件处于它没预期的
 * 中间状态，后续编辑全部错位。宁可整批退回让它重读。
 *
 * 实际拼接按 startLine 降序进行，保证靠前的行号在拼接过程中不失效。
 */
export function applyEdits(content: string, edits: LineEdit[]): ApplyEditsResult {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'edits 不能为空' };
  }

  const lines = toLines(content);
  const totalLines = lines.length;

  // ---- 1. 逐条校验 ----
  for (const edit of edits) {
    const { startLine, endLine } = edit;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      return { ok: false, error: `行号必须是整数，收到 startLine=${startLine}, endLine=${endLine}` };
    }
    if (typeof edit.content !== 'string') {
      return { ok: false, error: `edit.content 必须是字符串（startLine=${startLine}）` };
    }
    if (startLine < 1) {
      return { ok: false, error: `startLine 必须 ≥ 1，收到 ${startLine}` };
    }
    if (startLine > totalLines + 1) {
      return {
        ok: false,
        error: `startLine ${startLine} 超出文件范围（共 ${totalLines} 行，末尾追加最多用 ${totalLines + 1}）`,
      };
    }
    if (endLine < startLine - 1) {
      return {
        ok: false,
        error: `endLine ${endLine} 不能小于 startLine - 1（startLine=${startLine}）。纯插入请用 endLine = startLine - 1`,
      };
    }
    if (endLine > totalLines) {
      return { ok: false, error: `endLine ${endLine} 超出文件范围（共 ${totalLines} 行）` };
    }
    if (edit.expectFirstLine !== undefined && endLine >= startLine) {
      const actual = lines[startLine - 1] ?? '';
      if (actual.trim() !== String(edit.expectFirstLine).trim()) {
        return {
          ok: false,
          error:
            `第 ${startLine} 行内容与 expectFirstLine 不符。` +
            `期望 ${JSON.stringify(edit.expectFirstLine)}，实际 ${JSON.stringify(actual)}。` +
            `请重新 read_file 确认行号后再编辑。`,
        };
      }
    }
  }

  // ---- 2. 重叠检查 ----
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const prevIsInsert = prev.endLine < prev.startLine;
    const currIsInsert = curr.endLine < curr.startLine;

    if (prevIsInsert && currIsInsert && prev.startLine === curr.startLine) {
      return { ok: false, error: `第 ${curr.startLine} 行有两个插入编辑，先后顺序无法确定` };
    }
    // 替换区间：[startLine, endLine]；插入点：视为 startLine 前的零宽位置
    const prevEnd = prevIsInsert ? prev.startLine - 1 : prev.endLine;
    if (!currIsInsert && curr.startLine <= prevEnd) {
      return {
        ok: false,
        error: `编辑区间重叠：[${prev.startLine}, ${prev.endLine}] 与 [${curr.startLine}, ${curr.endLine}]`,
      };
    }
    if (currIsInsert && curr.startLine <= prevEnd) {
      return {
        ok: false,
        error: `插入点 ${curr.startLine} 落在编辑区间 [${prev.startLine}, ${prev.endLine}] 内部`,
      };
    }
  }

  // ---- 3. 升序累计偏移，算出每条编辑在新内容里的位置 ----
  let delta = 0;
  const changed: AppliedEditRange[] = sorted.map((edit) => {
    const removed = Math.max(0, edit.endLine - edit.startLine + 1);
    const inserted = toLines(edit.content).length;
    const newStart = edit.startLine + delta;
    const newEnd = newStart + inserted - 1; // inserted === 0 时 newEnd < newStart，表示纯删除
    delta += inserted - removed;
    return { oldStart: edit.startLine, oldEnd: edit.endLine, newStart, newEnd, removed, inserted };
  });

  // ---- 4. 降序拼接 ----
  const out = [...lines];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const edit = sorted[i];
    const removed = Math.max(0, edit.endLine - edit.startLine + 1);
    out.splice(edit.startLine - 1, removed, ...toLines(edit.content));
  }

  const nextContent = fromLines(out);
  return {
    ok: true,
    content: nextContent,
    totalLines: out.length,
    changed,
    preview: buildChangePreview(out, changed),
  };
}

/**
 * 把所有改动区域（各带上下 3 行）拼成一段带号文本。
 * 相邻区域会合并，不连续处插入 `...` 分隔，避免回传一整个文件。
 */
function buildChangePreview(lines: string[], changed: AppliedEditRange[]): string {
  if (lines.length === 0) return '(文件为空)';

  const windows = changed
    .map((c) => {
      // 纯删除时 newEnd < newStart，退回展示删除位置附近
      const from = Math.max(1, c.newStart - PREVIEW_CONTEXT_LINES);
      const to = Math.min(lines.length, Math.max(c.newStart, c.newEnd) + PREVIEW_CONTEXT_LINES);
      return { from, to };
    })
    .sort((a, b) => a.from - b.from);

  const merged: { from: number; to: number }[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.from <= last.to + 1) {
      last.to = Math.max(last.to, w.to);
    } else {
      merged.push({ ...w });
    }
  }

  return merged
    .map(({ from, to }) => numberLines(lines.slice(from - 1, to), from))
    .join('\n...\n');
}

/** 给系统提示词用的文件清单，形如 `index.html — 142 行` */
export function describeReplicaFiles(files: ReplicaFiles): string {
  return REPLICA_FILE_PATHS.map((path) => `- ${path} — ${countLines(files[path])} 行`).join('\n');
}
