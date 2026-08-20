import { beforeEach, describe, expect, it, vi } from 'vitest';

const forageStores = vi.hoisted(() => new Map<string, Map<string, unknown>>());
const readErrors = vi.hoisted(() => new Set<string>());

vi.mock('localforage', () => ({
  default: {
    createInstance: ({ name, storeName }: { name: string; storeName: string }) => {
      const storeId = `${name}/${storeName}`;
      const getStore = () => {
        let store = forageStores.get(storeId);
        if (!store) {
          store = new Map<string, unknown>();
          forageStores.set(storeId, store);
        }
        return store;
      };
      return {
        keys: vi.fn(async () => Array.from(getStore().keys())),
        getItem: vi.fn(async (key: string) => {
          if (readErrors.has(`${storeId}/${key}`)) throw new Error('unreadable blob');
          return getStore().get(key) ?? null;
        }),
        clear: vi.fn(async () => getStore().clear()),
        setItem: vi.fn(async (key: string, value: unknown) => {
          getStore().set(key, value);
          return value;
        }),
      };
    },
  },
}));

import { BlobZipArchive, StreamingZipWriter } from '../backup-archive';
import { exportAllData, importAllData } from '../backup-utils';

const CANVAS_STATE_STORE = 'nova-image/canvas_app_state';
const CANVAS_IMAGE_STORE = 'nova-image/canvas_image_files';

function canvasState(storageKeys: string[]) {
  return JSON.stringify({
    state: {
      projects: [{
        nodes: storageKeys.map((storageKey) => ({ type: 'image', metadata: { storageKey } })),
      }],
    },
    version: 0,
  });
}

describe('full backup canvas images', () => {
  beforeEach(() => {
    forageStores.clear();
    readErrors.clear();
    localStorage.clear();
  });

  it('exports referenced canvas blobs one at a time and restores them', async () => {
    forageStores.set(CANVAS_STATE_STORE, new Map([
      ['nova-image:canvas_store', canvasState(['image:used'])],
    ]));
    forageStores.set(CANVAS_IMAGE_STORE, new Map([
      ['image:broken-unused', new Blob(['unused'], { type: 'image/png' })],
      ['image:used', new Blob(['canvas-image'], { type: 'image/png' })],
    ]));
    readErrors.add(`${CANVAS_IMAGE_STORE}/image:broken-unused`);

    const backup = await exportAllData();
    const archive = await BlobZipArchive.open(backup);
    const localForage = JSON.parse((await archive.readText('localforage/nova-image.json')) ?? '{}');

    expect(localForage.canvas_image_files).toHaveLength(1);
    expect(localForage.canvas_image_files[0]).toMatchObject({
      key: 'image:used',
      _blobMimeType: 'image/png',
    });
    expect(archive.list('blobs/')).toContain(`blobs/${localForage.canvas_image_files[0]._blobRef}`);

    forageStores.set(CANVAS_STATE_STORE, new Map());
    forageStores.set(CANVAS_IMAGE_STORE, new Map());
    await importAllData(new File([backup], 'backup.zip', { type: 'application/zip' }));

    const restored = forageStores.get(CANVAS_IMAGE_STORE)?.get('image:used');
    expect(restored).toBeInstanceOf(Blob);
    expect((restored as Blob).size).toBe(12);
  });

  it('rejects a backup with canvas references but no image index before clearing data', async () => {
    const writer = new StreamingZipWriter();
    await writer.addJson('metadata.json', { appName: 'Nova Image' });
    await writer.addJson('localStorage.json', { theme: 'backup-theme' });
    await writer.addJson('localforage/nova-image.json', {
      canvas_app_state: [{ key: 'nova-image:canvas_store', value: canvasState(['image:missing']) }],
    });
    const backup = await writer.finalize();
    localStorage.setItem('theme', 'current-theme');

    await expect(importAllData(new File([backup], 'broken.zip', { type: 'application/zip' })))
      .rejects.toThrow('备份不完整：无限画布引用了 1 张图片，但备份中没有图片索引');
    expect(localStorage.getItem('theme')).toBe('current-theme');
  });
});
