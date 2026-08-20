import { describe, expect, it } from 'vitest';

import {
  composeReplicaPreview,
  parseMultiFileOutput,
  resolveReplicaFiles,
  sanitizeReplicaFiles,
  type HydratedAsset,
} from '@/lib/slice-reconstruct';

const DIMS = { previewWidth: 390, previewHeight: 844, sourceWidth: 390, sourceHeight: 844 };

const ASSET = {
  id: 'asset-1',
  name: '头像',
  kind: 'icon',
  radius: 8,
  placement: { x: 20, y: 40, width: 64, height: 64 },
};

function hydrated(id: string): HydratedAsset {
  return {
    id,
    name: id,
    dataUrl: 'data:image/png;base64,AAAA',
    placement: { x: 0, y: 0, width: 10, height: 10 },
    radius: 0,
  };
}

describe('parseMultiFileOutput', () => {
  it('按分隔符拆出三个文件', () => {
    const files = parseMultiFileOutput(
      [
        '===== FILE: index.html =====',
        '<!doctype html><html><body></body></html>',
        '===== FILE: styles.css =====',
        '.a { color: red; }',
        '===== FILE: script.js =====',
        'console.log(1);',
        '===== END =====',
      ].join('\n'),
    );
    expect(files['index.html']).toContain('<!doctype html>');
    expect(files['styles.css']).toBe('.a { color: red; }');
    expect(files['script.js']).toBe('console.log(1);');
  });

  it('容忍分隔符的长度与大小写差异', () => {
    const files = parseMultiFileOutput(
      ['== file: INDEX.HTML ==', '<p>x</p>', '=== File: styles.css ===', 'p{}'].join('\n'),
    );
    expect(files['index.html']).toBe('<p>x</p>');
    expect(files['styles.css']).toBe('p{}');
  });

  it('剥掉模型顺手加的代码围栏', () => {
    const files = parseMultiFileOutput(
      ['===== FILE: styles.css =====', '```css', '.a{}', '```'].join('\n'),
    );
    expect(files['styles.css']).toBe('.a{}');
  });

  // 模型偶尔会退回单份 HTML 的老习惯。这时降级拆分，让用户拿到一个能用的页面，
  // 远好过丢一句"解析失败"然后什么都没有。
  it('没有分隔符时降级：把单份 HTML 拆成三份', () => {
    const files = parseMultiFileOutput(
      '<!doctype html><html><head><style>.a{color:red}</style></head><body><script>go()</script></body></html>',
    );
    expect(files['styles.css']).toBe('.a{color:red}');
    expect(files['script.js']).toBe('go()');
    expect(files['index.html']).toContain('href="./styles.css"');
    expect(files['index.html']).not.toContain('color:red');
  });
});

describe('sanitizeReplicaFiles — 安全清洗', () => {
  const base = {
    'index.html': '<!doctype html><html><head></head><body><div class="screen"></div></body></html>',
    'styles.css': '.a{}',
    'script.js': 'const x = 1;',
  };

  it('移除行内 script 与事件处理器', () => {
    const out = sanitizeReplicaFiles(
      {
        ...base,
        'index.html':
          '<html><head></head><body><div class="screen" onclick="steal()"></div><script>evil()</script></body></html>',
      },
      [],
      DIMS,
    );
    expect(out.files['index.html']).not.toContain('evil()');
    expect(out.files['index.html']).not.toContain('onclick');
  });

  it('移除远程 link/iframe，只留本地引用', () => {
    const out = sanitizeReplicaFiles(
      {
        ...base,
        'index.html':
          '<html><head><link rel="stylesheet" href="https://cdn.example.com/a.css"></head><body><iframe src="https://x.com"></iframe><div class="screen"></div></body></html>',
      },
      [],
      DIMS,
    );
    expect(out.files['index.html']).not.toContain('cdn.example.com');
    expect(out.files['index.html']).not.toContain('<iframe');
  });

  // 「先全删再补」保证 index.html 里永远恰好一份规范引用，
  // 不会出现半个 </script> 之类的二次匹配残留。
  it('总是补回规范化的本地 css/js 引用，且各只有一份', () => {
    const html = sanitizeReplicaFiles(base, [], DIMS).files['index.html'];
    expect(html.match(/href="\.\/styles\.css"/g)).toHaveLength(1);
    expect(html.match(/src="\.\/script\.js"/g)).toHaveLength(1);
    expect(html).not.toContain('</script></script>');
  });

  it('把残留的行内 <style> 抽到 styles.css', () => {
    const out = sanitizeReplicaFiles(
      { ...base, 'index.html': '<html><head><style>.inline{color:blue}</style></head><body><div class="screen"></div></body></html>' },
      [],
      DIMS,
    );
    expect(out.files['index.html']).not.toContain('color:blue');
    expect(out.files['styles.css']).toContain('.inline{color:blue}');
  });

  it('CSS 里的远程 url() 与 @import 被清掉', () => {
    const out = sanitizeReplicaFiles(
      { ...base, 'styles.css': '@import url("https://x.com/a.css");\n.a{background:url(https://x.com/b.png)}' },
      [],
      DIMS,
    );
    expect(out.files['styles.css']).not.toContain('x.com');
  });

  it('script.js 为空时填入占位注释，保证文件始终存在', () => {
    const out = sanitizeReplicaFiles({ ...base, 'script.js': '   ' }, [], DIMS);
    expect(out.files['script.js']).toBe('// 本页暂无交互逻辑');
  });
});

describe('sanitizeReplicaFiles — 切图锚点', () => {
  it('保留已知资产的 img，丢弃模型自己发明的图片', () => {
    const out = sanitizeReplicaFiles(
      {
        'index.html':
          '<html><head></head><body><div class="screen">' +
          '<img data-reference-asset="asset-1" src="asset:asset-1">' +
          '<img src="https://x.com/fake.png">' +
          '</div></body></html>',
        'styles.css': '',
        'script.js': '',
      },
      [ASSET],
      DIMS,
    );
    expect(out.files['index.html']).toContain('data-reference-asset="asset-1"');
    expect(out.files['index.html']).not.toContain('fake.png');
    expect(out.referenceAnchorCount).toBe(1);
    expect(out.missingReferenceAnchorCount).toBe(0);
  });

  it('模型遗漏锚点时补入，并把定位规则写进 styles.css', () => {
    const out = sanitizeReplicaFiles(
      {
        'index.html': '<html><head></head><body><div class="screen"></div></body></html>',
        'styles.css': '.a{}',
        'script.js': '',
      },
      [ASSET],
      DIMS,
    );
    expect(out.missingReferenceAnchorCount).toBe(1);
    expect(out.files['index.html']).toContain('plugin-reference-fallback-1');
    expect(out.files['styles.css']).toContain('.plugin-reference-fallback-1{');
    expect(out.qualityWarnings[0]).toContain('遗漏 1 个切图锚点');
  });

  // 尺寸保护样式是预览专用的 !important 补丁。写进文件的话 agent 会看到它、
  // 可能改坏它，导出的产物也会带上不属于用户页面的东西。
  it('尺寸保护样式不写进文件', () => {
    const out = sanitizeReplicaFiles(
      {
        'index.html': '<html><head></head><body><div class="screen"></div></body></html>',
        'styles.css': '.a{}',
        'script.js': '',
      },
      [],
      DIMS,
    );
    expect(out.files['index.html']).not.toContain('data-fast-preview-guard');
    expect(out.files['styles.css']).not.toContain('!important');
  });
});

describe('composeReplicaPreview', () => {
  const files = {
    'index.html':
      '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body><div class="screen"><img data-reference-asset="a1" src="asset:a1"></div><script src="./script.js" defer></script></body></html>',
    'styles.css': '.screen{width:100px}',
    'script.js': 'document.title = "x";',
  };

  it('把 css 与 js 内联进单份 HTML', () => {
    const html = composeReplicaPreview(files, [], { previewWidth: 390, previewHeight: 844 });
    expect(html).toContain('.screen{width:100px}');
    expect(html).toContain('document.title = "x";');
    expect(html).not.toContain('href="./styles.css"');
    expect(html).not.toContain('src="./script.js"');
  });

  // 保护样式必须排在作者样式之后，!important 才压得住 .screen 尺寸。
  it('尺寸保护样式注入在作者样式之后', () => {
    const html = composeReplicaPreview(files, [], { previewWidth: 390, previewHeight: 844 });
    expect(html.indexOf('data-fast-preview-guard')).toBeGreaterThan(html.indexOf('data-replica-styles'));
    expect(html).toContain('width:390px!important');
  });

  // JS 里出现 </script> 会提前闭合内联标签，把后面的 HTML 全变成脚本外的文本。
  it('转义 js 里的 </script>，避免提前闭合内联标签', () => {
    const html = composeReplicaPreview(
      { ...files, 'script.js': 'const s = "</script>";' },
      [],
      { previewWidth: 1, previewHeight: 1 },
    );
    expect(html).toContain('<\\/script>');
    expect(html.match(/<\/script\s*>/gi) ?? []).toHaveLength(1);
  });

  it('把 asset:<id> 换成真实 dataUrl', () => {
    const html = composeReplicaPreview(files, [hydrated('a1')], { previewWidth: 1, previewHeight: 1 });
    expect(html).toContain('data:image/png;base64,AAAA');
    expect(html).not.toContain('src="asset:a1"');
  });

  it('index.html 缺少引用标签时也能注入', () => {
    const html = composeReplicaPreview(
      { 'index.html': '<html><head></head><body></body></html>', 'styles.css': '.z{}', 'script.js': 'z()' },
      [],
      { previewWidth: 1, previewHeight: 1 },
    );
    expect(html).toContain('.z{}');
    expect(html).toContain('z()');
  });
});

describe('resolveReplicaFiles', () => {
  it('优先返回已存的三文件', () => {
    const files = { 'index.html': '<p>a</p>', 'styles.css': 'a{}', 'script.js': 'a()' };
    expect(resolveReplicaFiles({ replicaFiles: files, reconstructedHtml: '<p>legacy</p>' })).toEqual(files);
  });

  // 旧工作区只有单文件字段。就地拆分，用户打开时不会看到空白，
  // 也就不需要给 IndexedDB 升版本。
  it('旧记录的单文件 HTML 就地拆成三份', () => {
    const resolved = resolveReplicaFiles({
      reconstructedHtml: '<html><head><style>.old{}</style></head><body></body></html>',
    });
    expect(resolved?.['styles.css']).toBe('.old{}');
    expect(resolved?.['index.html']).toContain('href="./styles.css"');
    expect(resolved?.['script.js']).toBe('// 本页暂无交互逻辑');
  });

  it('两者都没有时返回 null', () => {
    expect(resolveReplicaFiles({})).toBeNull();
    expect(resolveReplicaFiles(null)).toBeNull();
    expect(resolveReplicaFiles({ reconstructedHtml: '   ' })).toBeNull();
  });
});
