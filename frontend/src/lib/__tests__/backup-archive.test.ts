import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { BlobZipArchive, StreamingZipWriter } from '../backup-archive';

const UINT32_WRAP = 0x100000000;
const SIG_END_OF_CENTRAL_DIRECTORY = 0x06054b50;

function findCentralDirectoryOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = bytes.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === SIG_END_OF_CENTRAL_DIRECTORY) {
      return view.getUint32(i + 16, true);
    }
  }
  throw new Error('EOCD not found');
}

function readBlob(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
        return;
      }
      reject(new Error('Unable to read Blob'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read Blob'));
    reader.readAsArrayBuffer(blob);
  });
}

class WrappedCentralDirectoryBlob {
  readonly size: number;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly centralDirectoryOffset: number,
  ) {
    this.size = UINT32_WRAP + bytes.byteLength;
  }

  slice(start = 0, end = this.size): Blob {
    const chunks: Uint8Array[] = [];
    let cursor = start;

    while (cursor < end) {
      if (cursor < this.centralDirectoryOffset) {
        const chunkEnd = Math.min(end, this.centralDirectoryOffset);
        chunks.push(this.bytes.slice(cursor, chunkEnd));
        cursor = chunkEnd;
        continue;
      }

      if (cursor < UINT32_WRAP) {
        const chunkEnd = Math.min(end, UINT32_WRAP);
        chunks.push(new Uint8Array(chunkEnd - cursor));
        cursor = chunkEnd;
        continue;
      }

      const physicalStart = cursor - UINT32_WRAP;
      const physicalEnd = Math.min(this.bytes.byteLength, end - UINT32_WRAP);
      chunks.push(this.bytes.slice(physicalStart, physicalEnd));
      cursor = UINT32_WRAP + physicalEnd;
    }

    return new Blob(chunks);
  }
}

describe('backup archive ZIP reader/writer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a ZIP that can be read by fflate and the streaming archive reader', async () => {
    const writer = new StreamingZipWriter();
    await writer.addJson('metadata.json', { appName: 'Nova Image' });
    await writer.addBlob('blobs/sample', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }));

    const zip = await writer.finalize();
    const zipBytes = await readBlob(zip);
    const unzipped = unzipSync(zipBytes);

    expect(strFromU8(unzipped['metadata.json'])).toContain('Nova Image');
    expect(Array.from(unzipped['blobs/sample'])).toEqual([1, 2, 3, 4]);

    const archive = await BlobZipArchive.open(zip);
    expect(JSON.parse((await archive.readText('metadata.json')) ?? '{}')).toMatchObject({ appName: 'Nova Image' });
    const blob = await archive.readBlob('blobs/sample', 'image/png');
    expect(blob?.type).toBe('image/png');
    expect(Array.from(await readBlob(blob!))).toEqual([1, 2, 3, 4]);
  });

  it('can recover a legacy archive whose central directory offset wrapped after 4GB', async () => {
    const writer = new StreamingZipWriter();
    await writer.addJson('metadata.json', { appName: 'Nova Image', wrapped: true });
    await writer.addBlob('blobs/sample', new Blob([new Uint8Array([9, 8, 7])]));

    const normalZip = await writer.finalize();
    const zipBytes = await readBlob(normalZip);
    const centralDirectoryOffset = findCentralDirectoryOffset(zipBytes);
    const wrappedBlob = new WrappedCentralDirectoryBlob(zipBytes, centralDirectoryOffset) as unknown as Blob;

    const archive = await BlobZipArchive.open(wrappedBlob);
    expect(JSON.parse((await archive.readText('metadata.json')) ?? '{}')).toMatchObject({ wrapped: true });
    const blob = await archive.readBlob('blobs/sample');
    expect(Array.from(await readBlob(blob!))).toEqual([9, 8, 7]);
  });

  it('encodes large JSON entries in bounded chunks', async () => {
    const originalEncode = TextEncoder.prototype.encode;
    const encodeSpy = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (input = '') {
      if (input.length > 64 * 1024) {
        throw new DOMException('Failed to allocate buffer', 'EncodingError');
      }
      return originalEncode.call(this, input);
    });
    const payload = {
      text: `${'a'.repeat(64 * 1024 - 1)}\ud83d\ude00${'b'.repeat(128 * 1024)}`,
    };
    const writer = new StreamingZipWriter();

    await writer.addJson('large.json', payload);
    const archive = await BlobZipArchive.open(await writer.finalize());

    expect(JSON.parse((await archive.readText('large.json')) ?? '{}')).toEqual(payload);
    expect(Math.max(...encodeSpy.mock.calls.map(([input = '']) => input.length))).toBeLessThanOrEqual(64 * 1024);
  });
});
