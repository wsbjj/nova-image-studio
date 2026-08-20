import { describe, expect, it } from 'vitest';

import { buildPinnedPrefix, buildWebAgentSystemPrompt } from '@/lib/web-agent/prompts';
import { executeWebAgentTool, WEB_AGENT_TOOLS } from '@/lib/web-agent/tools';
import { MAX_READ_LINES, type ReplicaFiles } from '@/lib/web-agent/vfs';

const FILES: ReplicaFiles = {
  'index.html': '<html>\n<body>\n<div class="screen"></div>\n</body>\n</html>',
  'styles.css': '.screen {\n  width: 390px;\n}',
  'script.js': '// noop',
};

function run(name: string, args: unknown, files: ReplicaFiles = FILES) {
  return executeWebAgentTool(name, JSON.stringify(args), files);
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

describe('WEB_AGENT_TOOLS', () => {
  // 文件系统固定的核心保障：模型在 schema 层面就选不出第四个文件，
  // 也没有任何新建/删除文件的工具可用。
  it('只有读和改两个工具，路径被 enum 限死', () => {
    expect(WEB_AGENT_TOOLS.map((tool) => tool.name)).toEqual(['read_file', 'edit_file']);
    for (const tool of WEB_AGENT_TOOLS) {
      const properties = tool.parameters.properties as { path: { enum: string[] } };
      expect(properties.path.enum).toEqual(['index.html', 'styles.css', 'script.js']);
    }
  });
});

describe('executeWebAgentTool — read_file', () => {
  it('返回带行号的内容与总行数', () => {
    const result = run('read_file', { path: 'styles.css' });
    expect(result.ok).toBe(true);
    const payload = parse(result.output);
    expect(payload.totalLines).toBe(3);
    expect(payload.content).toContain('1| .screen {');
    expect(result.summary).toBe('已阅读 styles.css（1-3 行，共 3 行）');
  });

  it('支持区间读取', () => {
    const payload = parse(run('read_file', { path: 'index.html', startLine: 2, endLine: 3 }).output);
    expect(payload.startLine).toBe(2);
    expect(payload.endLine).toBe(3);
  });

  it('超长文件被截断并提示续读方式', () => {
    const long = Array.from({ length: MAX_READ_LINES + 20 }, (_, i) => `l${i}`).join('\n');
    const payload = parse(run('read_file', { path: 'script.js' }, { ...FILES, 'script.js': long }).output);
    expect(payload.truncated).toBe(true);
    expect(String(payload.note)).toContain('startLine/endLine');
  });
});

describe('executeWebAgentTool — edit_file', () => {
  it('按行替换并返回新文件内容', () => {
    const result = run('edit_file', {
      path: 'styles.css',
      edits: [{ startLine: 2, endLine: 2, content: '  width: 414px;' }],
    });
    expect(result.ok).toBe(true);
    expect(result.files['styles.css']).toContain('414px');
    expect(result.files['index.html']).toBe(FILES['index.html']);
    expect(result.summary).toBe('已编辑 styles.css（2-2 行 → 1 行）');
  });

  // 模型需要看到改完之后的真实内容才能自校正，只回一句"成功"是不够的。
  it('回传改动区域的实际内容供模型自校正', () => {
    const payload = parse(
      run('edit_file', {
        path: 'styles.css',
        edits: [{ startLine: 2, endLine: 2, content: '  width: 414px;' }],
      }).output,
    );
    expect(String(payload.preview)).toContain('414px');
    expect(String(payload.note)).toContain('若与预期不符');
  });

  it('入参不改动原对象', () => {
    const before = { ...FILES };
    run('edit_file', { path: 'styles.css', edits: [{ startLine: 1, endLine: 1, content: 'x' }] });
    expect(FILES).toEqual(before);
  });

  it('行号错误时返回可读原因而不是抛异常', () => {
    const result = run('edit_file', {
      path: 'styles.css',
      edits: [{ startLine: 99, endLine: 99, content: 'x' }],
    });
    expect(result.ok).toBe(false);
    expect(parse(result.output).ok).toBe(false);
    expect(result.summary).toContain('超出文件范围');
    expect(result.files).toBe(FILES);
  });

  it('expectFirstLine 不匹配时拒绝并要求重读', () => {
    const result = run('edit_file', {
      path: 'styles.css',
      edits: [{ startLine: 1, endLine: 1, content: 'x', expectFirstLine: '.footer {' }],
    });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('read_file');
  });
});

describe('executeWebAgentTool — 拒绝越界操作', () => {
  // 「不支持新建文件」不能只写在提示词里：模型照样会尝试，
  // 执行层必须硬拒并说明原因，否则它会反复重试同一个不存在的路径。
  it('未知路径被拒，并说明文件系统是固定的', () => {
    const result = run('edit_file', { path: 'about.html', edits: [] });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('不能新建或删除文件');
  });

  it('只读的 assets/ 路径同样被拒', () => {
    expect(run('read_file', { path: 'assets/logo.png' }).ok).toBe(false);
  });

  it('参数不是合法 JSON 时返回错误而不是抛异常', () => {
    const result = executeWebAgentTool('read_file', '{"path": ', FILES);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('合法 JSON');
  });

  it('未知工具名被拒', () => {
    expect(run('delete_file', { path: 'styles.css' }).ok).toBe(false);
  });
});

describe('buildWebAgentSystemPrompt', () => {
  const prompt = buildWebAgentSystemPrompt({
    files: FILES,
    assets: [
      { id: 'a1', name: '头像', kind: 'icon', placement: { x: 10, y: 20, width: 64, height: 64 } },
    ],
    screen: { width: 390, height: 844 },
  });

  it('列出三个文件及其行数', () => {
    expect(prompt).toContain('index.html — 5 行');
    expect(prompt).toContain('styles.css — 3 行');
  });

  // 资产清单每轮重建，成本低（约 50 token/资产）却能保证 agent 永远知道有哪些素材、在哪。
  it('列出每个切图资产的 id 与坐标', () => {
    expect(prompt).toContain('asset:a1');
    expect(prompt).toContain('x=10, y=20, w=64, h=64');
  });

  it('明确禁止新建与删除文件', () => {
    expect(prompt).toContain('不能新建文件，不能删除文件');
  });

  it('资产为空时给出明确说明而不是留空', () => {
    const bare = buildWebAgentSystemPrompt({
      files: FILES,
      assets: [],
      screen: { width: 1, height: 1 },
    });
    expect(bare).toContain('当前没有切图资产');
  });
});

describe('buildPinnedPrefix', () => {
  it('把源截图与资产总览图钉在系统提示之后', () => {
    const messages = buildPinnedPrefix({
      systemPrompt: 'sys',
      sourceImageDataUrl: 'data:image/png;base64,AAA',
      contactSheetDataUrl: 'data:image/webp;base64,BBB',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    const images = messages[1].content.filter((part) => part.type === 'image');
    expect(images).toHaveLength(2);
  });

  // 总览图是增强项。canvas 不可用或没有资产时应当照常发请求，而不是整轮失败。
  it('没有总览图时只挂源截图', () => {
    const messages = buildPinnedPrefix({
      systemPrompt: 'sys',
      sourceImageDataUrl: 'data:image/png;base64,AAA',
      contactSheetDataUrl: null,
    });
    expect(messages[1].content.filter((part) => part.type === 'image')).toHaveLength(1);
  });

  it('两张图都没有时只剩系统消息', () => {
    const messages = buildPinnedPrefix({
      systemPrompt: 'sys',
      sourceImageDataUrl: null,
      contactSheetDataUrl: null,
    });
    expect(messages).toHaveLength(1);
  });
});
