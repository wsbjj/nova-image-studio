import { describe, expect, it } from 'vitest';

import { readImageResponse } from '@/lib/slice-ai-client';

/** 构造一个仅包含所需字段的最小 Response。 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** jsdom 的 Blob 没有 arrayBuffer()，用 FileReader 读取字节。 */
function firstBytes(blob: Blob, count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result as ArrayBuffer;
      resolve(Array.from(new Uint8Array(buffer).subarray(0, count)));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** 1x1 透明 PNG 的 base64。 */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('readImageResponse', () => {
  it('decodes b64_json into a png Blob', async () => {
    const blob = await readImageResponse(
      jsonResponse({ output_format: 'png', data: [{ b64_json: PNG_1X1 }] }),
    );
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
    // 解码后应为真正的 PNG 字节，而不是 JSON 文本
    expect(await firstBytes(blob, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('honors output_format and normalizes jpg to jpeg', async () => {
    const blob = await readImageResponse(
      jsonResponse({ output_format: 'jpg', data: [{ b64_json: PNG_1X1 }] }),
    );
    expect(blob.type).toBe('image/jpeg');
  });

  it('accepts image_base64 and base64 aliases', async () => {
    await expect(
      readImageResponse(jsonResponse({ data: [{ image_base64: PNG_1X1 }] })),
    ).resolves.toBeInstanceOf(Blob);
    await expect(
      readImageResponse(jsonResponse({ data: [{ base64: PNG_1X1 }] })),
    ).resolves.toBeInstanceOf(Blob);
  });

  it('strips a data URL prefix before decoding', async () => {
    const blob = await readImageResponse(
      jsonResponse({ data: [{ b64_json: `data:image/png;base64,${PNG_1X1}` }] }),
    );
    expect(await firstBytes(blob, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('reads top-level b64_json when data array is absent', async () => {
    const blob = await readImageResponse(jsonResponse({ b64_json: PNG_1X1 }));
    expect(blob.type).toBe('image/png');
  });

  it('skips entries without image payloads', async () => {
    const blob = await readImageResponse(
      jsonResponse({ data: [{ revised_prompt: 'x' }, { b64_json: PNG_1X1 }] }),
    );
    expect(blob.size).toBeGreaterThan(0);
  });

  it('passes through a raw image body', async () => {
    const raw = new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
    const blob = await readImageResponse(raw);
    expect(blob.type).toBe('image/png');
  });

  it('throws when no image field is present instead of returning a json blob', async () => {
    await expect(readImageResponse(jsonResponse({ data: [] }))).rejects.toThrow(
      '图片编辑接口未返回图片数据',
    );
  });

  it('surfaces an error message from the payload', async () => {
    await expect(
      readImageResponse(jsonResponse({ error: { message: '内容被拒绝' } })),
    ).rejects.toThrow('内容被拒绝');
  });

  it('throws on a non-JSON body', async () => {
    const bad = new Response('<html>oops</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    await expect(readImageResponse(bad)).rejects.toThrow('无法解析');
  });
});
