import { describe, expect, it } from 'vitest';

import {
  extractStreamingEditContent,
  extractStreamingPath,
  scanJsonStringFields,
} from '@/lib/web-agent/partial-json';

const FULL_ARGS = JSON.stringify({
  path: 'styles.css',
  edits: [
    { startLine: 4, endLine: 6, content: '.title {\n  color: "#2563eb";\n}' },
    { startLine: 9, endLine: 9, content: '  opacity: 1;' },
  ],
});

describe('scanJsonStringFields', () => {
  it('抽出完整 JSON 里的字符串键值对', () => {
    const fields = scanJsonStringFields(FULL_ARGS);
    expect(fields.find((f) => f.key === 'path')?.value).toBe('styles.css');
    expect(fields.filter((f) => f.key === 'content')).toHaveLength(2);
  });

  // 数字值不能被后面某个不相干的字符串顶替掉，否则 startLine 会被当成有字符串值。
  it('键的值不是字符串时不产生记录', () => {
    const fields = scanJsonStringFields('{"startLine":4,"content":"x"}');
    expect(fields.map((f) => f.key)).toEqual(['content']);
  });

  it('嵌套对象与数组不会打乱键值配对', () => {
    const fields = scanJsonStringFields('{"a":{"b":"1"},"c":["2"],"d":"3"}');
    expect(fields.find((f) => f.key === 'b')?.value).toBe('1');
    expect(fields.find((f) => f.key === 'd')?.value).toBe('3');
  });

  it('正在传输的键名不会被误当成值', () => {
    // '{"path":"a.css","conte' —— 末尾是半个键名，不是任何键的值
    const fields = scanJsonStringFields('{"path":"a.css","conte');
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe('path');
  });
});

describe('extractStreamingEditContent — 转义', () => {
  it('还原换行、引号与反斜杠', () => {
    const args = JSON.stringify({ content: 'a\nb"c\\d\te' });
    expect(extractStreamingEditContent(args)).toBe('a\nb"c\\d\te');
  });

  it('还原 \\uXXXX', () => {
    expect(extractStreamingEditContent('{"content":"\\u4f60\\u597d"}')).toBe('你好');
  });

  it('多段 content 用空行拼接', () => {
    expect(extractStreamingEditContent(FULL_ARGS)).toBe(
      '.title {\n  color: "#2563eb";\n}\n\n  opacity: 1;',
    );
  });
});

describe('extractStreamingEditContent — 流式前缀', () => {
  // 面板要随流增长而增长。任何前缀都不能抛异常，也不能因为转义被切断就倒退，
  // 否则用户会看到代码"往回缩"。
  it('对每一个前缀都单调不减且不抛异常', () => {
    let previous = 0;
    for (let i = 0; i <= FULL_ARGS.length; i += 1) {
      const partial = FULL_ARGS.slice(0, i);
      const text = extractStreamingEditContent(partial);
      expect(text.length).toBeGreaterThanOrEqual(previous);
      previous = text.length;
    }
    expect(extractStreamingEditContent(FULL_ARGS)).toContain('color:');
  });

  it('未闭合的 content 也能取到已到达的部分', () => {
    const partial = '{"path":"styles.css","edits":[{"startLine":4,"endLine":6,"content":".title {\\n  colo';
    expect(extractStreamingEditContent(partial)).toBe('.title {\n  colo');
  });

  it('悬空反斜杠被丢弃，等下个增量补齐', () => {
    expect(extractStreamingEditContent('{"content":"ab\\')).toBe('ab');
    expect(extractStreamingEditContent('{"content":"ab\\n')).toBe('ab\n');
  });

  it('半个 \\uXXXX 被丢弃', () => {
    expect(extractStreamingEditContent('{"content":"ab\\u4f')).toBe('ab');
    expect(extractStreamingEditContent('{"content":"ab\\u4f60')).toBe('ab你');
  });

  it('空输入返回空串', () => {
    expect(extractStreamingEditContent('')).toBe('');
  });
});

describe('extractStreamingPath', () => {
  it('取出已闭合的 path', () => {
    expect(extractStreamingPath(FULL_ARGS)).toBe('styles.css');
  });

  // path 还没传完就显示"正在编辑 sty"会闪烁，所以未闭合时宁可返回 null。
  it('path 尚未闭合时返回 null', () => {
    expect(extractStreamingPath('{"path":"sty')).toBeNull();
  });

  it('没有 path 字段时返回 null', () => {
    expect(extractStreamingPath('{"edits":[]}')).toBeNull();
  });
});
