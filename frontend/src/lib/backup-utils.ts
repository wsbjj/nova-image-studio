'use client';

import localforage from 'localforage';
import {
    BlobZipArchive,
    StreamingZipWriter,
    normalizeBackupArchiveError,
    type BackupArchiveReader,
} from './backup-archive';

export interface BackupProgress {
    percent: number;
    message: string;
}

export type ProgressCallback = (progress: BackupProgress) => void;

type BackupRecord = Record<string, unknown>;
type DatabaseBackup = Record<string, BackupRecord[]>;
type IndexedDBBackup = Record<string, DatabaseBackup>;
type BlobRef = { _blobRef: string; _blobMimeType: string };

function isBackupRecord(value: unknown): value is BackupRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlobRef(value: unknown): value is BlobRef {
    return isBackupRecord(value)
        && typeof value['_blobRef'] === 'string'
        && typeof value['_blobMimeType'] === 'string';
}

// localStorage keys to backup
const LOCAL_STORAGE_KEYS = [
    'nova-model-registry',
    'nova-jobs',
    'nova-t2i-settings',
    'nova-i2i-settings',
    'nova-reverse-prompt-settings',
    'theme',
    'nova-wide-mode',
    // Agent 模式
    'nova-agent-params',
    'nova-agent-web-search',
    'nova-agent-intent-recognition',
    // 动图生成
    'nova-gif-settings',
    'nova-gif-active-job',
    // 我的素材
    'nova-assets-settings',
    // 无限画布生成配置
    'nova-image:canvas_config',
];

// IndexedDB databases to backup
const INDEXEDDB_DATABASES = [
    { name: 'nova-image-db', version: 2, stores: ['images', 'blobs'] },
    { name: 'nova-reverse-db', version: 1, stores: ['reverse-results'] },
    { name: 'nova-upload-cache', version: 1, stores: ['images'] },
    // Agent 模式对话、图片登记、元信息
    { name: 'nova-agent-db', version: 1, stores: ['messages', 'images', 'meta'] },
    // 本地图片素材库
    { name: 'nova-assets-db', version: 1, stores: ['assets', 'asset-blobs'] },
];

// localforage keyless 实例（无限画布：项目状态 + 图片 blob）。
// 通用 IndexedDB 逻辑面向 keyPath store，无法 round-trip localforage 的无 keyPath store，故单独处理。
const LOCALFORAGE_STORES: { name: string; storeName: string }[] = [
    { name: 'nova-image', storeName: 'canvas_app_state' },
    { name: 'nova-image', storeName: 'canvas_image_files' },
];

const CANVAS_DB_NAME = 'nova-image';
const CANVAS_STATE_STORE = 'canvas_app_state';
const CANVAS_IMAGE_STORE = 'canvas_image_files';
const CANVAS_STATE_KEY = 'nova-image:canvas_store';

type LocalForageEntry = { key: string; value: unknown } | { key: string; _blobRef: string; _blobMimeType: string };
type LocalForageBackup = Record<string, Record<string, LocalForageEntry[]>>;

// 用于生成导出时 Blob 的唯一引用 ID
let _blobRefSeq = 0;
function nextBlobRef(): string {
    return `b${Date.now()}_${++_blobRefSeq}`;
}

function yieldToMain(): Promise<void> {
    return new Promise((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
            return;
        }
        setTimeout(resolve, 0);
    });
}

function isBlobValue(value: unknown): value is Blob {
    if (!value || typeof value !== 'object') return false;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
    // localforage may return a Blob from another realm (for example, after a
    // browser restores an IndexedDB value).  `instanceof` is false across
    // realms, while the brand check remains stable.
    return Object.prototype.toString.call(value) === '[object Blob]';
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function collectStorageKeys(value: unknown): Set<string> {
    const keys = new Set<string>();
    const pending: unknown[] = [value];

    while (pending.length) {
        const current = pending.pop();
        if (!current || typeof current !== 'object') continue;
        if ('storageKey' in current && typeof current.storageKey === 'string' && current.storageKey.startsWith('image:')) {
            keys.add(current.storageKey);
        }
        for (const child of Object.values(current)) {
            if (child && typeof child === 'object') pending.push(child);
        }
    }

    return keys;
}

function getRequiredCanvasImageKeys(data: LocalForageBackup): Set<string> {
    const entries = data[CANVAS_DB_NAME]?.[CANVAS_STATE_STORE];
    if (!Array.isArray(entries)) return new Set();
    const stateEntry = entries.find((entry) => entry.key === CANVAS_STATE_KEY && 'value' in entry);
    if (!stateEntry || !('value' in stateEntry)) return new Set();

    try {
        const state = typeof stateEntry.value === 'string' ? JSON.parse(stateEntry.value) : stateEntry.value;
        return collectStorageKeys(state);
    } catch (error) {
        throw new Error(`无限画布状态无法解析：${describeError(error)}`);
    }
}

function validateCanvasImageEntries(data: LocalForageBackup, archive?: BackupArchiveReader): void {
    const requiredKeys = getRequiredCanvasImageKeys(data);
    if (!requiredKeys.size) return;

    const entries = data[CANVAS_DB_NAME]?.[CANVAS_IMAGE_STORE];
    if (!Array.isArray(entries)) {
        throw new Error(`备份不完整：无限画布引用了 ${requiredKeys.size} 张图片，但备份中没有图片索引`);
    }

    const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
    const archivePaths = archive ? new Set(archive.list('blobs/')) : null;
    const missingKeys: string[] = [];

    for (const key of requiredKeys) {
        const entry = entryByKey.get(key);
        if (!entry || !('_blobRef' in entry) || typeof entry._blobRef !== 'string') {
            missingKeys.push(key);
            continue;
        }
        if (archivePaths && !archivePaths.has(`blobs/${entry._blobRef}`)) missingKeys.push(key);
    }

    if (missingKeys.length) {
        throw new Error(`备份不完整：无限画布缺少 ${missingKeys.length}/${requiredKeys.size} 张节点图片`);
    }
}

async function exportLocalForageStore(
    cfg: { name: string; storeName: string },
    writer: StreamingZipWriter,
    selectedKeys?: Set<string>,
    onProgress?: ProgressCallback,
): Promise<LocalForageEntry[]> {
    const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
    const availableKeys = await instance.keys();
    const availableKeySet = new Set(availableKeys);
    const keys = selectedKeys ? Array.from(selectedKeys).sort() : availableKeys;
    const entries: LocalForageEntry[] = [];

    if (selectedKeys) {
        const missingKeys = keys.filter((key) => !availableKeySet.has(key));
        if (missingKeys.length) {
            throw new Error(`本地图片库缺少 ${missingKeys.length}/${keys.length} 张节点图片`);
        }
    }

    // Read one key at a time.  Iterating the whole store into an array first
    // keeps every large Blob alive and can exhaust the renderer before the ZIP
    // writer gets a chance to release it.
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        let value: unknown;
        try {
            value = await instance.getItem<unknown>(key);
        } catch (error) {
            throw new Error(`无法读取图片 ${key}：${describeError(error)}`);
        }
        if (isBlobValue(value)) {
            const ref = nextBlobRef();
            await writer.addBlob(`blobs/${ref}`, value);
            entries.push({ key, _blobRef: ref, _blobMimeType: value.type });
        } else if (selectedKeys) {
            throw new Error(`节点图片 ${key} 不是有效的 Blob`);
        } else {
            entries.push({ key, value });
        }

        if (index % 4 === 0 || index === keys.length - 1) {
            onProgress?.({
                percent: 92,
                message: `正在导出无限画布图片 ${cfg.storeName} (${index + 1}/${keys.length})...`,
            });
            await yieldToMain();
        }
    }

    return entries;
}

/**
 * 导出 localforage（keyless）store：保留 key；Blob 值以二进制存入 ZIP blobs/，JSON 内留引用。
 * 数据逐 store 写入 files 对象，释放引用后可被 GC 回收。
 */
async function exportLocalForage(writer: StreamingZipWriter, onProgress?: ProgressCallback): Promise<LocalForageBackup> {
    const result: LocalForageBackup = {};
    for (const cfg of LOCALFORAGE_STORES) {
        try {
            const selectedKeys = cfg.name === CANVAS_DB_NAME && cfg.storeName === CANVAS_IMAGE_STORE
                ? getRequiredCanvasImageKeys(result)
                : undefined;
            const entries = await exportLocalForageStore(cfg, writer, selectedKeys, onProgress);
            if (!result[cfg.name]) result[cfg.name] = {};
            result[cfg.name][cfg.storeName] = entries;
        } catch (error) {
            throw new Error(`导出 ${cfg.name}/${cfg.storeName} 失败：${describeError(error)}`);
        }
    }
    validateCanvasImageEntries(result);
    return result;
}

/**
 * 导入 localforage（keyless）store：先清空，再按 key 写回；Blob 从 ZIP 还原。
 */
async function importLocalForage(data: LocalForageBackup, archive: BackupArchiveReader): Promise<void> {
    for (const cfg of LOCALFORAGE_STORES) {
        const entries = data[cfg.name]?.[cfg.storeName];
        if (!Array.isArray(entries)) continue;
        try {
            const instance = localforage.createInstance({ name: cfg.name, storeName: cfg.storeName });
            await instance.clear();
            for (const entry of entries) {
                let value: unknown;
                if ('_blobRef' in entry && typeof entry._blobRef === 'string') {
                    const blob = await archive.readBlob(`blobs/${entry._blobRef}`, entry._blobMimeType);
                    if (!blob) throw new Error(`缺少图片条目 blobs/${entry._blobRef}`);
                    value = blob;
                } else {
                    value = (entry as { value: unknown }).value;
                }
                await instance.setItem(entry.key, value);
            }
        } catch (error) {
            throw new Error(`导入 ${cfg.name}/${cfg.storeName} 失败：${describeError(error)}`);
        }
    }
}

/**
 * 导出 localStorage 数据
 */
function exportLocalStorage(): Record<string, string> {
    const data: Record<string, string> = {};

    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            const value = localStorage.getItem(key);
            if (value !== null) {
                data[key] = value;
            }
        } catch {
            // skip failed localStorage export
        }
    }

    return data;
}

/**
 * 打开 IndexedDB 数据库
 */
function openDatabase(name: string, version: number, createStores: boolean = false): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
        if (typeof indexedDB === 'undefined') {
            resolve(null);
            return;
        }

        const request = indexedDB.open(name, version);

        request.onerror = () => resolve(null);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            const oldVersion = e.oldVersion || 0;
            if (!createStores && oldVersion > 0) return;

            // 根据数据库名称创建相应的 stores
            if (name === 'nova-image-db') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'key' });
                }
            } else if (name === 'nova-reverse-db') {
                if (!db.objectStoreNames.contains('reverse-results')) {
                    db.createObjectStore('reverse-results', { keyPath: 'slot' });
                }
            } else if (name === 'nova-upload-cache') {
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'key' });
                }
            } else if (name === 'nova-agent-db') {
                if (!db.objectStoreNames.contains('messages')) {
                    db.createObjectStore('messages', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('images')) {
                    db.createObjectStore('images', { keyPath: 'imgId' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            } else if (name === 'nova-assets-db') {
                if (!db.objectStoreNames.contains('assets')) {
                    const store = db.createObjectStore('assets', { keyPath: 'id' });
                    store.createIndex('hash', 'hash', { unique: false });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
                if (!db.objectStoreNames.contains('asset-blobs')) {
                    db.createObjectStore('asset-blobs', { keyPath: 'key' });
                }
            }
        };
    });
}

/**
 * 导出单个 IndexedDB store 的所有数据
 * Blob 字段转为 Uint8Array 存入 files，JSON 中只保留引用
 */
async function exportStore(
    db: IDBDatabase,
    storeName: string,
    writer: StreamingZipWriter,
    onRecordProgress?: (processed: number, total: number) => void,
): Promise<BackupRecord[]> {
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = async () => {
                const records = request.result;

                const processedRecords: BackupRecord[] = [];

                for (let index = 0; index < records.length; index++) {
                    const processed = { ...records[index] };

                    // 遍历所有字段，将 Blob 类型以二进制存入 files
                    for (const key of Object.keys(processed)) {
                        const val = processed[key];
                        if (val instanceof Blob) {
                            const ref = nextBlobRef();
                            await writer.addBlob(`blobs/${ref}`, val);
                            processed[key] = { _blobRef: ref, _blobMimeType: val.type };
                        }
                    }

                    processedRecords.push(processed);
                    if (index % 10 === 0 || index === records.length - 1) {
                        onRecordProgress?.(index + 1, records.length);
                        await yieldToMain();
                    }
                }

                resolve(processedRecords);
            };

            request.onerror = () => reject(request.error);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * 导出所有 IndexedDB 数据
 * 逐数据库、逐 store 顺序处理，处理完立即写入 files，降低内存峰值
 */
async function exportIndexedDB(writer: StreamingZipWriter, onProgress?: ProgressCallback): Promise<IndexedDBBackup> {
    const allData: IndexedDBBackup = {};
    let completedStores = 0;
    const totalStores = INDEXEDDB_DATABASES.reduce((sum, db) => sum + db.stores.length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const db = await openDatabase(dbConfig.name, dbConfig.version);

        if (!db) {
            continue;
        }

        const dbData: DatabaseBackup = {};

        for (const storeName of dbConfig.stores) {
            try {
                if (!db.objectStoreNames.contains(storeName)) {
                    continue;
                }

                const startPercent = 10 + Math.floor((completedStores / totalStores) * 80);
                const endPercent = 10 + Math.floor(((completedStores + 1) / totalStores) * 80);
                onProgress?.({
                    percent: startPercent,
                    message: `正在导出 ${dbConfig.name}/${storeName}...`,
                });

                const storeData = await exportStore(db, storeName, writer, (processed, total) => {
                    const ratio = total > 0 ? processed / total : 1;
                    const percent = Math.min(endPercent - 1, startPercent + Math.floor((endPercent - startPercent) * ratio));
                    onProgress?.({
                        percent,
                        message: `正在导出 ${dbConfig.name}/${storeName} (${processed}/${total})...`,
                    });
                });
                dbData[storeName] = storeData;

                completedStores++;
                if (onProgress) {
                    onProgress({
                        percent: endPercent,
                        message: `正在导出 ${dbConfig.name}/${storeName}...`,
                    });
                }
            } catch {
                // store export failed, continue with next
            }
        }

        db.close();
        allData[dbConfig.name] = dbData;
    }

    return allData;
}

/**
 * 导出所有数据为 ZIP 文件
 * 使用 ZIP64 流式写入，避免大备份在浏览器内生成超大 ArrayBuffer。
 */
export async function exportAllData(onProgress?: ProgressCallback): Promise<Blob> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导出数据...' });
    }

    // 导出 localStorage
    if (onProgress) {
        onProgress({ percent: 5, message: '正在导出 localStorage...' });
    }
    const localStorageData = exportLocalStorage();

    const writer = new StreamingZipWriter();

    // 逐 store 导出 IndexedDB，Blob 数据直接流式写入 ZIP。
    const indexedDBData = await exportIndexedDB(writer, onProgress);

    // 导出 localforage 数据
    const localForageData = await exportLocalForage(writer, onProgress);

    // 打包元数据和 localStorage JSON
    if (onProgress) {
        onProgress({ percent: 90, message: '正在打包数据...' });
    }

    // 添加元数据
    await writer.addJson('metadata.json', {
        version: process.env.NEXT_PUBLIC_APP_VERSION || '0.0.0',
        exportDate: new Date().toISOString(),
        appName: 'Nova Image',
    });

    // 添加 localStorage 数据
    await writer.addJson('localStorage.json', localStorageData);

    // 添加 IndexedDB 数据
    for (const [dbName, dbData] of Object.entries(indexedDBData)) {
        await writer.addJson(`indexedDB/${dbName}.json`, dbData);
    }

    // 添加 localforage（无限画布）数据
    for (const [dbName, dbData] of Object.entries(localForageData)) {
        await writer.addJson(`localforage/${dbName}.json`, dbData);
    }

    if (onProgress) {
        onProgress({ percent: 95, message: '正在生成 ZIP 文件...' });
    }

    await yieldToMain();

    const blob = await writer.finalize();

    if (onProgress) {
        onProgress({ percent: 100, message: '导出完成！' });
    }

    return blob;
}

/**
 * 从 base64 字符串创建 Blob
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);

    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }

    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
}

/**
 * 导入 localStorage 数据（带校验）
 */
function importLocalStorage(data: unknown): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return;

    const allowedKeySet = new Set(LOCAL_STORAGE_KEYS);
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (!allowedKeySet.has(key)) continue;
        if (typeof value !== 'string') continue;

        if (key === 'nova-model-registry') {
            try {
                const parsed = JSON.parse(value);
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    continue;
                }
                const record = parsed as Record<string, unknown>;
                const hasImageModels = Array.isArray(record.imageModels);
                const hasTextModels = Array.isArray(record.textModels);
                const hasDefaults = typeof record.defaults === 'object' && record.defaults !== null;
                if (!hasImageModels || !hasTextModels || !hasDefaults) {
                    continue;
                }
            } catch {
                continue;
            }
        }

        try {
            localStorage.setItem(key, value);
        } catch {
            // skip failed localStorage import
        }
    }
}

/**
 * 删除 IndexedDB 数据库
 */
async function deleteDatabase(name: string): Promise<void> {
    if (typeof indexedDB === 'undefined') return;

    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => {
            // 即使被阻塞也继续，因为可能是其他标签页打开了数据库
            resolve();
        };
    });
}

/**
 * 导入单个 store 的数据
 */
async function hydrateRecord(record: BackupRecord, archive: BackupArchiveReader): Promise<BackupRecord> {
    const processed: BackupRecord = { ...record };

    for (const key of Object.keys(processed)) {
        const val = processed[key];

        // 新格式：_blobRef 对象 → 从 ZIP 条目按需恢复 Blob
        if (isBlobRef(val)) {
            const blob = await archive.readBlob(`blobs/${val._blobRef}`, val._blobMimeType);
            if (blob) {
                processed[key] = blob;
            }
            continue;
        }

        // 旧格式兼容：base64 字符串 + _blobMimeType
        if (key === 'blob' && typeof val === 'string' && typeof record._blobMimeType === 'string') {
            processed.blob = base64ToBlob(val, record._blobMimeType);
        }
    }

    // 清理旧格式遗留的 _blobMimeType（新格式按字段内嵌携带）
    if ('_blobMimeType' in processed && typeof processed._blobMimeType === 'string') {
        delete processed._blobMimeType;
    }

    return processed;
}

async function putRecord(db: IDBDatabase, storeName: string, record: BackupRecord): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            store.put(record);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        } catch (error) {
            reject(error);
        }
    });
}

async function importStore(db: IDBDatabase, storeName: string, records: BackupRecord[], archive: BackupArchiveReader): Promise<void> {
    for (let index = 0; index < records.length; index++) {
        const processed = await hydrateRecord(records[index], archive);
        await putRecord(db, storeName, processed);
        if (index % 10 === 0) {
            await yieldToMain();
        }
    }
}

/**
 * 导入 IndexedDB 数据
 */
async function importIndexedDB(data: IndexedDBBackup, archive: BackupArchiveReader, onProgress?: ProgressCallback): Promise<void> {
    let completedStores = 0;
    const totalStores = Object.values(data).reduce((sum, dbData) => sum + Object.keys(dbData).length, 0);

    for (const dbConfig of INDEXEDDB_DATABASES) {
        const dbData = data[dbConfig.name];
        if (!dbData) continue;

        // 先删除整个数据库，确保重新创建
        await deleteDatabase(dbConfig.name);

        // 重新打开数据库并导入数据（createStores=true 以便创建 stores）
        const db = await openDatabase(dbConfig.name, dbConfig.version, true);
        if (!db) {
            continue;
        }

        for (const storeName of dbConfig.stores) {
            try {
                const storeData = dbData[storeName];
                if (!storeData || !Array.isArray(storeData)) continue;

                if (!db.objectStoreNames.contains(storeName)) {
                    continue;
                }

                await importStore(db, storeName, storeData, archive);

                completedStores++;
                if (onProgress) {
                    const percent = 20 + Math.floor((completedStores / totalStores) * 70);
                    onProgress({
                        percent,
                        message: `正在导入 ${dbConfig.name}/${storeName}...`,
                    });
                }
            } catch {
                // store import failed, continue with next
            }
        }

        db.close();
    }
}

/**
 * 从 ZIP 文件导入所有数据（覆盖现有数据）
 * 按 ZIP 中央目录读取条目，兼容 ZIP64 和旧版 JSZip 备份，避免一次性读入整个备份文件。
 */
export async function importAllData(file: File, onProgress?: ProgressCallback): Promise<void> {
    if (onProgress) {
        onProgress({ percent: 0, message: '开始导入数据...' });
    }

    if (onProgress) {
        onProgress({ percent: 5, message: '正在解析备份文件...' });
    }

    let archive: BlobZipArchive;
    try {
        archive = await BlobZipArchive.open(file);
    } catch (error) {
        throw normalizeBackupArchiveError(error);
    }

    if (onProgress) {
        onProgress({ percent: 8, message: '正在读取备份索引...' });
    }

    const metadataText = await archive.readText('metadata.json');
    if (metadataText) {
        const metadata = JSON.parse(metadataText) as Record<string, unknown>;
        if (metadata.incremental === true) {
            throw new Error('不支持导入非完整备份文件，请选择完整备份文件');
        }
    }

    // 在覆盖任何现有数据之前校验画布图片索引。旧实现可能在图片
    // store 导出失败后仍生成 ZIP，表现为“导入成功”但所有节点图片为空。
    const localForageData: LocalForageBackup = {};
    for (const path of archive.list('localforage/', '.json')) {
        const dbName = path.replace('localforage/', '').replace('.json', '');
        const text = await archive.readText(path);
        if (text) localForageData[dbName] = JSON.parse(text);
    }
    validateCanvasImageEntries(localForageData, archive);

    // 读取 localStorage 数据
    if (onProgress) {
        onProgress({ percent: 10, message: '正在清空 localStorage...' });
    }

    // 清空现有 localStorage
    for (const key of LOCAL_STORAGE_KEYS) {
        try {
            localStorage.removeItem(key);
        } catch {
            // skip failed localStorage removal
        }
    }

    if (onProgress) {
        onProgress({ percent: 15, message: '正在导入 localStorage...' });
    }

    const localStorageText = await archive.readText('localStorage.json');
    if (localStorageText) {
        const localStorageData = JSON.parse(localStorageText);
        importLocalStorage(localStorageData);
    }

    // 读取 IndexedDB 数据
    const indexedDBData: IndexedDBBackup = {};
    for (const path of archive.list('indexedDB/', '.json')) {
        const dbName = path.replace('indexedDB/', '').replace('.json', '');
        const text = await archive.readText(path);
        if (text) indexedDBData[dbName] = JSON.parse(text);
    }

    // 导入 IndexedDB
    await importIndexedDB(indexedDBData, archive, onProgress);

    // 读取并导入 localforage（无限画布）数据
    if (onProgress) {
        onProgress({ percent: 92, message: '正在导入无限画布数据...' });
    }
    await importLocalForage(localForageData, archive);

    if (onProgress) {
        onProgress({ percent: 100, message: '导入完成！' });
    }
}

/**
 * 下载 Blob 为文件
 */
export function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Safari 需要延迟撤销，否则下载可能失败
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 生成备份文件名
 */
export function generateBackupFilename(): string {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    return `nova-backup-${dateStr}-${timeStr}.zip`;
}
