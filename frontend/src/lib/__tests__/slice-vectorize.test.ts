import { describe, expect, it } from 'vitest';

import {
  countSvgShapes,
  normalizeVectorSvg,
  sanitizeGeneratedSvg,
  SvgValidationError,
  svgToDataUrl,
} from '@/lib/slice-vectorize';

const VALID = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';

describe('sanitizeGeneratedSvg', () => {
  it('accepts a minimal valid SVG', () => {
    expect(sanitizeGeneratedSvg(VALID)).toBe(VALID);
  });

  it('strips markdown fences the model wraps around the output', () => {
    expect(sanitizeGeneratedSvg(`\`\`\`svg\n${VALID}\n\`\`\``)).toBe(VALID);
    expect(sanitizeGeneratedSvg(`\`\`\`xml\n${VALID}\n\`\`\``)).toBe(VALID);
    expect(sanitizeGeneratedSvg(`\`\`\`\n${VALID}\n\`\`\``)).toBe(VALID);
  });

  it('extracts the SVG when the model adds prose around it', () => {
    expect(sanitizeGeneratedSvg(`Here you go:\n${VALID}\nHope that helps!`)).toBe(VALID);
  });

  it('rejects output with no SVG at all', () => {
    expect(() => sanitizeGeneratedSvg('I cannot do that.')).toThrow(SvgValidationError);
    expect(() => sanitizeGeneratedSvg('')).toThrow(SvgValidationError);
  });

  // 这是校验器存在的首要理由：内嵌位图的「假矢量」看起来完全正常
  it('rejects an embedded raster masquerading as vector', () => {
    const fake =
      '<svg viewBox="0 0 24 24"><image href="data:image/png;base64,AAAA"/><path d="M0 0"/></svg>';
    expect(() => sanitizeGeneratedSvg(fake)).toThrow(/内嵌了位图/);
  });

  it('rejects base64 payloads even outside an image tag', () => {
    const fake =
      '<svg viewBox="0 0 24 24"><path fill="url(data:image/png;base64,AAAA)" d="M0 0"/></svg>';
    expect(() => sanitizeGeneratedSvg(fake)).toThrow(SvgValidationError);
  });

  it('rejects script, foreignObject, event handlers, and external refs', () => {
    expect(() =>
      sanitizeGeneratedSvg('<svg viewBox="0 0 1 1"><path d="M0 0"/><script>x()</script></svg>'),
    ).toThrow(/script/);
    expect(() =>
      sanitizeGeneratedSvg('<svg viewBox="0 0 1 1"><foreignObject/><path d="M0 0"/></svg>'),
    ).toThrow(/foreignObject/);
    expect(() =>
      sanitizeGeneratedSvg('<svg viewBox="0 0 1 1"><path onclick="x()" d="M0 0"/></svg>'),
    ).toThrow(/事件处理属性/);
    expect(() =>
      sanitizeGeneratedSvg('<svg viewBox="0 0 1 1"><use href="#x"/><path d="M0 0"/></svg>'),
    ).toThrow(/外部资源/);
    expect(() =>
      sanitizeGeneratedSvg('<svg viewBox="0 0 1 1"><a xlink:href="javascript:x()"/><path d="M0 0"/></svg>'),
    ).toThrow(SvgValidationError);
  });

  it('requires a viewBox so the asset can be scaled correctly', () => {
    expect(() => sanitizeGeneratedSvg('<svg width="24"><path d="M0 0"/></svg>')).toThrow(/viewBox/);
  });

  it('requires at least one editable shape element', () => {
    expect(() => sanitizeGeneratedSvg('<svg viewBox="0 0 1 1"><g></g></svg>')).toThrow(
      /没有可编辑图形元素/,
    );
  });

  it('rejects an SVG with an unreasonable number of shapes', () => {
    const many = `<svg viewBox="0 0 24 24">${'<path d="M0 0"/>'.repeat(221)}</svg>`;
    expect(() => sanitizeGeneratedSvg(many)).toThrow(/图层过多/);
  });

  it('accepts exactly at the shape-count ceiling', () => {
    const atLimit = `<svg viewBox="0 0 24 24">${'<path d="M0 0"/>'.repeat(220)}</svg>`;
    expect(() => sanitizeGeneratedSvg(atLimit)).not.toThrow();
  });
});

describe('countSvgShapes', () => {
  it('counts every editable shape tag and ignores containers', () => {
    const svg =
      '<svg><g><path/><rect/><circle/><ellipse/><line/><polyline/><polygon/></g><defs/></svg>';
    expect(countSvgShapes(svg)).toBe(7);
  });

  it('returns zero when there are no shapes', () => {
    expect(countSvgShapes('<svg><g/></svg>')).toBe(0);
  });
});

describe('normalizeVectorSvg', () => {
  it('forces width, height, and viewBox onto the root tag', () => {
    const out = normalizeVectorSvg('<svg viewBox="0 0 24 24"><path/></svg>', 120, 48);
    expect(out).toContain('width="120"');
    expect(out).toContain('height="48"');
    expect(out).toContain('viewBox="0 0 120 48"');
  });

  it('replaces existing dimensions rather than duplicating them', () => {
    const out = normalizeVectorSvg(
      '<svg width="24" height="24" viewBox="0 0 24 24"><path/></svg>',
      64,
      64,
    );
    expect(out.match(/width=/g)).toHaveLength(1);
    expect(out.match(/viewBox=/gi)).toHaveLength(1);
    expect(out).toContain('viewBox="0 0 64 64"');
  });

  it('leaves child content untouched', () => {
    const out = normalizeVectorSvg('<svg viewBox="0 0 1 1"><path d="M1 2 L3 4"/></svg>', 10, 10);
    expect(out).toContain('<path d="M1 2 L3 4"/>');
  });

  it('throws when there is no root svg tag', () => {
    expect(() => normalizeVectorSvg('<div/>', 10, 10)).toThrow(SvgValidationError);
  });
});

describe('svgToDataUrl', () => {
  it('produces a utf-8 encoded svg data url', () => {
    const url = svgToDataUrl('<svg viewBox="0 0 1 1"><path/></svg>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(url.split(',')[1])).toContain('<svg');
  });
});
