import { describe, expect, it } from 'vitest';

import {
  applyEdits,
  countLines,
  fromLines,
  readLines,
  toLines,
  MAX_READ_LINES,
  type LineEdit,
} from '@/lib/web-agent/vfs';

const CSS = [
  ':root {',
  '  --bg: #ffffff;',
  '}',
  '.title {',
  '  color: #111111;',
  '  font-size: 20px;',
  '}',
  '.footer {',
  '  opacity: 0.6;',
  '}',
].join('\n');

function edit(partial: Partial<LineEdit> & Pick<LineEdit, 'startLine' | 'endLine'>): LineEdit {
  return { content: '', ...partial };
}

describe('toLines / fromLines', () => {
  // 无损往返是整个行编辑的地基：一旦拆行会吃掉结尾换行，
  // 多轮编辑之后文件末尾会莫名其妙地少行，且极难定位到是哪一轮丢的。
  it('对结尾换行保持无损往返', () => {
    for (const sample of ['', 'a', 'a\n', 'a\nb', 'a\nb\n', '\n', '\n\n']) {
      expect(fromLines(toLines(sample))).toBe(sample);
    }
  });

  it('统一 CRLF 为 LF', () => {
    expect(toLines('a\r\nb')).toEqual(['a', 'b']);
  });

  it('空串是 0 行', () => {
    expect(countLines('')).toBe(0);
  });
});

describe('readLines', () => {
  it('返回右对齐的带号文本', () => {
    const result = readLines('styles.css', CSS, 4, 6);
    expect(result.startLine).toBe(4);
    expect(result.endLine).toBe(6);
    expect(result.totalLines).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('4| .title {\n5|   color: #111111;\n6|   font-size: 20px;');
  });

  it('缺省参数读全文', () => {
    const result = readLines('styles.css', CSS);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(10);
  });

  // 越界读取是只读操作，夹紧比报错对模型更有用——它能直接拿到能拿的部分继续干活。
  it('越界区间被夹紧而不是报错', () => {
    const result = readLines('styles.css', CSS, -5, 999);
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(10);
  });

  it('超过 MAX_READ_LINES 时截断并置位 truncated', () => {
    const long = Array.from({ length: MAX_READ_LINES + 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = readLines('index.html', long);
    expect(result.truncated).toBe(true);
    expect(result.endLine).toBe(MAX_READ_LINES);
  });

  it('空文件返回空文本', () => {
    const result = readLines('script.js', '');
    expect(result.totalLines).toBe(0);
    expect(result.text).toBe('');
  });
});

describe('applyEdits — 正常路径', () => {
  it('替换单行', () => {
    const result = applyEdits(CSS, [edit({ startLine: 5, endLine: 5, content: '  color: #2563eb;' })]);
    if (!result.ok) throw new Error(result.error);
    expect(toLines(result.content)[4]).toBe('  color: #2563eb;');
    expect(result.totalLines).toBe(10);
  });

  it('多行替换成不同行数，totalLines 随之变化', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 4, endLine: 7, content: '.title { color: red; }' }),
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.totalLines).toBe(7);
    expect(result.changed[0]).toMatchObject({ removed: 4, inserted: 1, newStart: 4, newEnd: 4 });
  });

  it('content 为空串表示删除', () => {
    const result = applyEdits(CSS, [edit({ startLine: 8, endLine: 10 })]);
    if (!result.ok) throw new Error(result.error);
    expect(result.totalLines).toBe(7);
    expect(result.content.includes('.footer')).toBe(false);
  });

  it('endLine = startLine - 1 是纯插入', () => {
    const result = applyEdits(CSS, [edit({ startLine: 4, endLine: 3, content: '/* 标题 */' })]);
    if (!result.ok) throw new Error(result.error);
    expect(result.totalLines).toBe(11);
    expect(toLines(result.content)[3]).toBe('/* 标题 */');
    expect(toLines(result.content)[4]).toBe('.title {');
  });

  it('startLine = totalLines + 1 可在末尾追加', () => {
    const result = applyEdits(CSS, [edit({ startLine: 11, endLine: 10, content: '.new {}' })]);
    if (!result.ok) throw new Error(result.error);
    expect(result.totalLines).toBe(11);
    expect(toLines(result.content)[10]).toBe('.new {}');
  });

  // 这是行编辑最容易写错的地方：若按升序拼接，第一处编辑改变行数后
  // 后面那处的行号就全错位了。所以内部必须降序 splice。
  it('多处编辑互不干扰（内部降序拼接）', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 2, endLine: 2, content: '  --bg: #000000;' }),
      edit({ startLine: 5, endLine: 6, content: '  color: red;' }),
      edit({ startLine: 9, endLine: 9, content: '  opacity: 1;' }),
    ]);
    if (!result.ok) throw new Error(result.error);
    const lines = toLines(result.content);
    expect(lines[1]).toBe('  --bg: #000000;');
    expect(lines[4]).toBe('  color: red;');
    // 前面少了一行，原第 9 行落到第 8 行
    expect(lines[7]).toBe('  opacity: 1;');
    expect(result.totalLines).toBe(9);
  });

  it('乱序传入的编辑同样正确', () => {
    const ordered = applyEdits(CSS, [
      edit({ startLine: 2, endLine: 2, content: 'A' }),
      edit({ startLine: 9, endLine: 9, content: 'B' }),
    ]);
    const shuffled = applyEdits(CSS, [
      edit({ startLine: 9, endLine: 9, content: 'B' }),
      edit({ startLine: 2, endLine: 2, content: 'A' }),
    ]);
    if (!ordered.ok || !shuffled.ok) throw new Error('应当成功');
    expect(shuffled.content).toBe(ordered.content);
  });

  it('preview 只回报改动区域附近而不是整个文件', () => {
    const result = applyEdits(CSS, [edit({ startLine: 5, endLine: 5, content: '  color: red;' })]);
    if (!result.ok) throw new Error(result.error);
    expect(result.preview).toContain('color: red;');
    // 第 1 行离改动点超过 3 行，不该出现
    expect(result.preview).not.toContain(':root {');
  });

  it('相隔很远的两处改动在 preview 里用 ... 分隔', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 1, endLine: 1, content: 'A' }),
      edit({ startLine: 10, endLine: 10, content: 'B' }),
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.preview).toContain('\n...\n');
  });
});

describe('applyEdits — 拒绝路径', () => {
  // 部分应用是最危险的失败模式：模型以为改了一半，实际文件处于它没预期的中间状态，
  // 后续编辑全部错位。所以任何一条不合法都必须整批退回。
  it('一条非法则整批拒绝，原内容不变', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 1, endLine: 1, content: 'ok' }),
      edit({ startLine: 999, endLine: 999, content: 'bad' }),
    ]);
    expect(result.ok).toBe(false);
  });

  it('endLine 越界被拒', () => {
    const result = applyEdits(CSS, [edit({ startLine: 1, endLine: 99 })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('超出文件范围');
  });

  it('startLine 超过 totalLines + 1 被拒', () => {
    const result = applyEdits(CSS, [edit({ startLine: 12, endLine: 11, content: 'x' })]);
    expect(result.ok).toBe(false);
  });

  it('endLine < startLine - 1 被拒', () => {
    const result = applyEdits(CSS, [edit({ startLine: 5, endLine: 2, content: 'x' })]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('endLine');
  });

  it('非整数行号被拒', () => {
    const result = applyEdits(CSS, [edit({ startLine: 1.5, endLine: 2, content: 'x' })]);
    expect(result.ok).toBe(false);
  });

  it('区间重叠被拒', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 4, endLine: 7, content: 'A' }),
      edit({ startLine: 6, endLine: 9, content: 'B' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('重叠');
  });

  it('同一位置两个插入被拒（顺序无法确定）', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 4, endLine: 3, content: 'A' }),
      edit({ startLine: 4, endLine: 3, content: 'B' }),
    ]);
    expect(result.ok).toBe(false);
  });

  it('插入点落在别的编辑区间内部被拒', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 4, endLine: 7, content: 'A' }),
      edit({ startLine: 6, endLine: 5, content: 'B' }),
    ]);
    expect(result.ok).toBe(false);
  });

  it('空编辑数组被拒', () => {
    expect(applyEdits(CSS, []).ok).toBe(false);
  });
});

describe('applyEdits — expectFirstLine 防漂移', () => {
  it('匹配时通过（忽略首尾空白）', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 4, endLine: 4, content: '.headline {', expectFirstLine: '  .title {  ' }),
    ]);
    expect(result.ok).toBe(true);
  });

  // 模型数错行是行编辑的主要失败源。带上期望内容就能在改坏之前拦下来，
  // 并且错误里要同时给出期望值和实际值，模型才知道该往哪个方向重新定位。
  it('不匹配时拒绝，并同时回报期望值与实际值', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 4, endLine: 4, content: 'x', expectFirstLine: '.footer {' }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('.footer {');
    expect(result.error).toContain('.title {');
    expect(result.error).toContain('read_file');
  });

  it('纯插入时不校验 expectFirstLine', () => {
    const result = applyEdits(CSS, [
      edit({ startLine: 4, endLine: 3, content: 'x', expectFirstLine: '完全对不上' }),
    ]);
    expect(result.ok).toBe(true);
  });
});
