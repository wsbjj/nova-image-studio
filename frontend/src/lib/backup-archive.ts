'use client';

import { inflateSync, strToU8 } from 'fflate';

const SIG_LOCAL_FILE_HEADER = 0x04034b50;
const SIG_CENTRAL_FILE_HEADER = 0x02014b50;
const SIG_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const SIG_ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const SIG_ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const SIG_DATA_DESCRIPTOR = 0x08074b50;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP64_EOCD_SIZE = 44;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const UINT32_WRAP = 0x100000000;
const ZIP_TAIL_SEARCH_SIZE = 1024 * 1024;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

type ZipRecord = {
    name: string;
    nameBytes: Uint8Array;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
    modTime: number;
    modDate: number;
};

type ZipEntry = {
    name: string;
    flags: number;
    method: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    localHeaderOffset: number;
};

export interface BackupArchiveReader {
    list(prefix?: string, suffix?: string): string[];
    readText(path: string): Promise<string | null>;
    readBlob(path: string, mimeType?: string): Promise<Blob | null>;
}

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crcTable[i] = c >>> 0;
    }
    return crcTable;
}

class Crc32 {
    private value = 0xffffffff;

    update(bytes: Uint8Array): void {
        const table = getCrcTable();
        let crc = this.value;
        for (let i = 0; i < bytes.length; i++) {
            crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        }
        this.value = crc >>> 0;
    }

    digest(): number {
        return (this.value ^ 0xffffffff) >>> 0;
    }
}

function writeUint64(view: DataView, offset: number, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`ZIP value is out of safe integer range: ${value}`);
    }
    const low = value % UINT32_WRAP;
    const high = Math.floor(value / UINT32_WRAP);
    view.setUint32(offset, low, true);
    view.setUint32(offset + 4, high, true);
}

function readUint64(view: DataView, offset: number): number {
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    const value = high * UINT32_WRAP + low;
    if (!Number.isSafeInteger(value)) {
        throw new Error('ZIP64 value is too large for this browser');
    }
    return value;
}

function makeBuffer(size: number): { bytes: Uint8Array; view: DataView } {
    const bytes = new Uint8Array(size);
    return { bytes, view: new DataView(bytes.buffer) };
}

function getDosDateTime(date = new Date()): { modTime: number; modDate: number } {
    const year = Math.max(1980, date.getFullYear());
    const modTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const modDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { modTime, modDate };
}

function makeZip64Extra(values: number[]): Uint8Array {
    const { bytes, view } = makeBuffer(4 + values.length * 8);
    view.setUint16(0, ZIP64_EXTRA_ID, true);
    view.setUint16(2, values.length * 8, true);
    values.forEach((value, index) => writeUint64(view, 4 + index * 8, value));
    return bytes;
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    if (typeof blob.arrayBuffer === 'function') {
        return blob.arrayBuffer();
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) {
                resolve(reader.result);
                return;
            }
            reject(new Error('Unable to read Blob as ArrayBuffer'));
        };
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read Blob'));
        reader.readAsArrayBuffer(blob);
    });
}

function isNotReadableFileError(error: unknown): boolean {
    if (error instanceof DOMException && error.name === 'NotReadableError') return true;
    const message = error instanceof Error ? error.message : String(error);
    return /requested file could not be read|notreadableerror/i.test(message);
}

export function normalizeBackupArchiveError(error: unknown): Error {
    if (isNotReadableFileError(error)) {
        return new Error('无法读取备份文件。请确认 ZIP 已下载完成，并把它复制到本机普通目录（例如“下载”或“桌面”）后重新选择，不要从浏览器临时下载项、网盘同步目录或已移动/删除的位置导入。');
    }
    if (error instanceof Error && /not a valid zip|invalid zip|unsupported zip|damaged zip/i.test(error.message)) {
        return new Error(`备份文件不是有效的 ZIP：${error.message}`);
    }
    return error instanceof Error ? error : new Error(String(error));
}

export class StreamingZipWriter {
    private readonly chunks: BlobPart[] = [];
    private readonly records: ZipRecord[] = [];
    private offset = 0;
    private finalized = false;
    private readonly encoder = new TextEncoder();
    private readonly timestamp = getDosDateTime();

    private append(part: Uint8Array | Blob): void {
        this.chunks.push(part as unknown as BlobPart);
        this.offset += part instanceof Blob ? part.size : part.byteLength;
    }

    private beginEntry(path: string, knownSize: number): {
        nameBytes: Uint8Array;
        localHeaderOffset: number;
        crc: Crc32;
        size: number;
        usesZip64Size: boolean;
    } {
        if (this.finalized) throw new Error('ZIP writer has already been finalized');
        const nameBytes = this.encoder.encode(path);
        const usesZip64Size = knownSize > UINT32_MAX;
        const extra = usesZip64Size ? makeZip64Extra([knownSize, knownSize]) : new Uint8Array(0);
        const { bytes: header, view } = makeBuffer(30);
        const localHeaderOffset = this.offset;

        view.setUint32(0, SIG_LOCAL_FILE_HEADER, true);
        view.setUint16(4, usesZip64Size ? 45 : 20, true);
        view.setUint16(6, FLAG_DATA_DESCRIPTOR | FLAG_UTF8, true);
        view.setUint16(8, METHOD_STORE, true);
        view.setUint16(10, this.timestamp.modTime, true);
        view.setUint16(12, this.timestamp.modDate, true);
        view.setUint32(14, 0, true);
        view.setUint32(18, usesZip64Size ? UINT32_MAX : 0, true);
        view.setUint32(22, usesZip64Size ? UINT32_MAX : 0, true);
        view.setUint16(26, nameBytes.byteLength, true);
        view.setUint16(28, extra.byteLength, true);

        this.append(header);
        this.append(nameBytes);
        if (extra.byteLength) this.append(extra);

        return {
            nameBytes,
            localHeaderOffset,
            crc: new Crc32(),
            size: 0,
            usesZip64Size,
        };
    }

    private pushEntryChunk(entry: ReturnType<StreamingZipWriter['beginEntry']>, bytes: Uint8Array): void {
        if (!bytes.byteLength) return;
        entry.crc.update(bytes);
        entry.size += bytes.byteLength;
        this.append(bytes);
    }

    private endEntry(path: string, entry: ReturnType<StreamingZipWriter['beginEntry']>): void {
        const crc32 = entry.crc.digest();
        const size = entry.size;
        const descriptorSize = entry.usesZip64Size ? 24 : 16;
        const { bytes: descriptor, view } = makeBuffer(descriptorSize);

        view.setUint32(0, SIG_DATA_DESCRIPTOR, true);
        view.setUint32(4, crc32, true);
        if (entry.usesZip64Size) {
            writeUint64(view, 8, size);
            writeUint64(view, 16, size);
        } else {
            view.setUint32(8, size, true);
            view.setUint32(12, size, true);
        }
        this.append(descriptor);

        this.records.push({
            name: path,
            nameBytes: entry.nameBytes,
            crc32,
            compressedSize: size,
            uncompressedSize: size,
            localHeaderOffset: entry.localHeaderOffset,
            modTime: this.timestamp.modTime,
            modDate: this.timestamp.modDate,
        });
    }

    addBytes(path: string, bytes: Uint8Array): void {
        const entry = this.beginEntry(path, bytes.byteLength);
        this.pushEntryChunk(entry, bytes);
        this.endEntry(path, entry);
    }

    addJson(path: string, data: unknown): void {
        this.addBytes(path, strToU8(JSON.stringify(data)));
    }

    async addBlob(path: string, blob: Blob): Promise<void> {
        const entry = this.beginEntry(path, blob.size);
        if (typeof blob.stream === 'function') {
            const reader = blob.stream().getReader();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) this.pushEntryChunk(entry, value);
                }
            } finally {
                reader.releaseLock();
            }
        } else {
            this.pushEntryChunk(entry, new Uint8Array(await readBlobAsArrayBuffer(blob)));
        }
        this.endEntry(path, entry);
    }

    async finalize(): Promise<Blob> {
        if (this.finalized) throw new Error('ZIP writer has already been finalized');
        this.finalized = true;

        const centralDirectoryStart = this.offset;
        let hasZip64 = false;

        for (const record of this.records) {
            const extraValues: number[] = [];
            const sizeNeedsZip64 = record.uncompressedSize > UINT32_MAX || record.compressedSize > UINT32_MAX;
            const offsetNeedsZip64 = record.localHeaderOffset > UINT32_MAX;
            if (record.uncompressedSize > UINT32_MAX) extraValues.push(record.uncompressedSize);
            if (record.compressedSize > UINT32_MAX) extraValues.push(record.compressedSize);
            if (offsetNeedsZip64) extraValues.push(record.localHeaderOffset);

            const extra = extraValues.length ? makeZip64Extra(extraValues) : new Uint8Array(0);
            const { bytes: header, view } = makeBuffer(46);
            const needsZip64 = sizeNeedsZip64 || offsetNeedsZip64;
            hasZip64 ||= needsZip64;

            view.setUint32(0, SIG_CENTRAL_FILE_HEADER, true);
            view.setUint16(4, needsZip64 ? 45 : 20, true);
            view.setUint16(6, needsZip64 ? 45 : 20, true);
            view.setUint16(8, FLAG_DATA_DESCRIPTOR | FLAG_UTF8, true);
            view.setUint16(10, METHOD_STORE, true);
            view.setUint16(12, record.modTime, true);
            view.setUint16(14, record.modDate, true);
            view.setUint32(16, record.crc32, true);
            view.setUint32(20, record.compressedSize > UINT32_MAX ? UINT32_MAX : record.compressedSize, true);
            view.setUint32(24, record.uncompressedSize > UINT32_MAX ? UINT32_MAX : record.uncompressedSize, true);
            view.setUint16(28, record.nameBytes.byteLength, true);
            view.setUint16(30, extra.byteLength, true);
            view.setUint16(32, 0, true);
            view.setUint16(34, 0, true);
            view.setUint16(36, 0, true);
            view.setUint32(38, 0, true);
            view.setUint32(42, offsetNeedsZip64 ? UINT32_MAX : record.localHeaderOffset, true);

            this.append(header);
            this.append(record.nameBytes);
            if (extra.byteLength) this.append(extra);
        }

        const centralDirectorySize = this.offset - centralDirectoryStart;
        hasZip64 ||= this.records.length > UINT16_MAX
            || centralDirectoryStart > UINT32_MAX
            || centralDirectorySize > UINT32_MAX;

        if (hasZip64) {
            const zip64EocdOffset = this.offset;
            const { bytes: zip64Eocd, view } = makeBuffer(56);
            view.setUint32(0, SIG_ZIP64_END_OF_CENTRAL_DIRECTORY, true);
            writeUint64(view, 4, ZIP64_EOCD_SIZE);
            view.setUint16(12, 45, true);
            view.setUint16(14, 45, true);
            view.setUint32(16, 0, true);
            view.setUint32(20, 0, true);
            writeUint64(view, 24, this.records.length);
            writeUint64(view, 32, this.records.length);
            writeUint64(view, 40, centralDirectorySize);
            writeUint64(view, 48, centralDirectoryStart);
            this.append(zip64Eocd);

            const { bytes: locator, view: locatorView } = makeBuffer(20);
            locatorView.setUint32(0, SIG_ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR, true);
            locatorView.setUint32(4, 0, true);
            writeUint64(locatorView, 8, zip64EocdOffset);
            locatorView.setUint32(16, 1, true);
            this.append(locator);
        }

        const { bytes: eocd, view: eocdView } = makeBuffer(22);
        eocdView.setUint32(0, SIG_END_OF_CENTRAL_DIRECTORY, true);
        eocdView.setUint16(4, 0, true);
        eocdView.setUint16(6, 0, true);
        eocdView.setUint16(8, this.records.length > UINT16_MAX ? UINT16_MAX : this.records.length, true);
        eocdView.setUint16(10, this.records.length > UINT16_MAX ? UINT16_MAX : this.records.length, true);
        eocdView.setUint32(12, centralDirectorySize > UINT32_MAX ? UINT32_MAX : centralDirectorySize, true);
        eocdView.setUint32(16, centralDirectoryStart > UINT32_MAX ? UINT32_MAX : centralDirectoryStart, true);
        eocdView.setUint16(20, 0, true);
        this.append(eocd);

        return new Blob(this.chunks, { type: 'application/zip' });
    }
}

export class BlobZipArchive implements BackupArchiveReader {
    private readonly entries = new Map<string, ZipEntry>();
    private readonly dataStartCache = new Map<string, number>();
    private readonly decoder = new TextDecoder();

    private constructor(private readonly blob: Blob) {}

    static async open(blob: Blob): Promise<BlobZipArchive> {
        const archive = new BlobZipArchive(blob);
        await archive.loadCentralDirectory();
        return archive;
    }

    list(prefix = '', suffix = ''): string[] {
        return Array.from(this.entries.keys()).filter((name) => (
            (!prefix || name.startsWith(prefix)) && (!suffix || name.endsWith(suffix))
        ));
    }

    async readText(path: string): Promise<string | null> {
        const bytes = await this.readBytes(path);
        return bytes ? this.decoder.decode(bytes) : null;
    }

    async readBlob(path: string, mimeType = ''): Promise<Blob | null> {
        const entry = this.entries.get(path);
        if (!entry) return null;
        if ((entry.flags & 1) !== 0) {
            throw new Error(`Unsupported ZIP encrypted entry: ${path}`);
        }

        const dataStart = await this.getDataStart(entry);
        if (entry.method === METHOD_STORE) {
            return this.blob.slice(dataStart, dataStart + entry.compressedSize, mimeType);
        }
        if (entry.method === METHOD_DEFLATE) {
            const bytes = await this.readBytes(path);
            return bytes ? new Blob([bytes as unknown as BlobPart], { type: mimeType }) : null;
        }
        throw new Error(`Unsupported ZIP compression method ${entry.method}: ${path}`);
    }

    private async readBytes(path: string): Promise<Uint8Array | null> {
        const entry = this.entries.get(path);
        if (!entry) return null;
        if ((entry.flags & 1) !== 0) {
            throw new Error(`Unsupported ZIP encrypted entry: ${path}`);
        }
        const dataStart = await this.getDataStart(entry);
        const compressed = new Uint8Array(await this.readSlice(dataStart, entry.compressedSize));
        if (entry.method === METHOD_STORE) return compressed;
        if (entry.method === METHOD_DEFLATE) return inflateSync(compressed);
        throw new Error(`Unsupported ZIP compression method ${entry.method}: ${path}`);
    }

    private async loadCentralDirectory(): Promise<void> {
        const eocd = await this.findEndOfCentralDirectory();
        let centralDirectoryOffset = eocd.centralDirectoryOffset;
        let centralDirectorySize = eocd.centralDirectorySize;
        let entries = eocd.entries;

        const zip64 = await this.tryReadZip64EndOfCentralDirectory(eocd.offset);
        if (zip64) {
            centralDirectoryOffset = zip64.centralDirectoryOffset;
            centralDirectorySize = zip64.centralDirectorySize;
            entries = zip64.entries;
        }

        centralDirectoryOffset = await this.resolveOffset(
            centralDirectoryOffset,
            SIG_CENTRAL_FILE_HEADER,
            0,
        );

        const central = new Uint8Array(await this.readSlice(centralDirectoryOffset, centralDirectorySize));
        const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
        let cursor = 0;
        let previousLocalHeaderOffset = 0;

        for (let entryIndex = 0; entryIndex < entries && cursor < central.byteLength; entryIndex++) {
            if (view.getUint32(cursor, true) !== SIG_CENTRAL_FILE_HEADER) {
                throw new Error('Invalid ZIP central directory');
            }

            const flags = view.getUint16(cursor + 8, true);
            const method = view.getUint16(cursor + 10, true);
            const crc32 = view.getUint32(cursor + 16, true);
            let compressedSize = view.getUint32(cursor + 20, true);
            let uncompressedSize = view.getUint32(cursor + 24, true);
            const nameLength = view.getUint16(cursor + 28, true);
            const extraLength = view.getUint16(cursor + 30, true);
            const commentLength = view.getUint16(cursor + 32, true);
            let localHeaderOffset = view.getUint32(cursor + 42, true);
            const nameStart = cursor + 46;
            const extraStart = nameStart + nameLength;
            const commentStart = extraStart + extraLength;
            const name = this.decoder.decode(central.subarray(nameStart, extraStart));
            const extra = central.subarray(extraStart, commentStart);

            const zip64Values = this.readZip64Extra(extra, {
                compressedSize,
                uncompressedSize,
                localHeaderOffset,
            });
            compressedSize = zip64Values.compressedSize;
            uncompressedSize = zip64Values.uncompressedSize;
            localHeaderOffset = zip64Values.localHeaderOffset;
            localHeaderOffset = await this.resolveOffset(
                localHeaderOffset,
                SIG_LOCAL_FILE_HEADER,
                previousLocalHeaderOffset,
            );
            previousLocalHeaderOffset = localHeaderOffset;

            this.entries.set(name, {
                name,
                flags,
                method,
                crc32,
                compressedSize,
                uncompressedSize,
                localHeaderOffset,
            });

            cursor = commentStart + commentLength;
        }
    }

    private async findEndOfCentralDirectory(): Promise<{
        offset: number;
        entries: number;
        centralDirectorySize: number;
        centralDirectoryOffset: number;
    }> {
        const tailLength = Math.min(this.blob.size, ZIP_TAIL_SEARCH_SIZE);
        const tailOffset = this.blob.size - tailLength;
        const tail = new Uint8Array(await this.readSlice(tailOffset, tailLength));
        const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

        for (let i = tail.byteLength - 22; i >= 0; i--) {
            if (view.getUint32(i, true) !== SIG_END_OF_CENTRAL_DIRECTORY) continue;
            const commentLength = view.getUint16(i + 20, true);
            if (i + 22 + commentLength !== tail.byteLength) continue;
            const disk = view.getUint16(i + 4, true);
            const centralDisk = view.getUint16(i + 6, true);
            if (disk !== 0 || centralDisk !== 0) {
                throw new Error('Unsupported ZIP multi-disk archive');
            }
            return {
                offset: tailOffset + i,
                entries: view.getUint16(i + 10, true),
                centralDirectorySize: view.getUint32(i + 12, true),
                centralDirectoryOffset: view.getUint32(i + 16, true),
            };
        }

        throw new Error('Not a valid ZIP archive: end of central directory not found');
    }

    private async tryReadZip64EndOfCentralDirectory(eocdOffset: number): Promise<{
        entries: number;
        centralDirectorySize: number;
        centralDirectoryOffset: number;
    } | null> {
        const locatorOffset = eocdOffset - 20;
        if (locatorOffset < 0) return null;
        const locator = new Uint8Array(await this.readSlice(locatorOffset, 20));
        const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
        if (locatorView.getUint32(0, true) !== SIG_ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) {
            return null;
        }

        const zip64EocdOffset = readUint64(locatorView, 8);
        const zip64Eocd = new Uint8Array(await this.readSlice(zip64EocdOffset, 56));
        const view = new DataView(zip64Eocd.buffer, zip64Eocd.byteOffset, zip64Eocd.byteLength);
        if (view.getUint32(0, true) !== SIG_ZIP64_END_OF_CENTRAL_DIRECTORY) {
            throw new Error('Invalid ZIP64 end of central directory');
        }

        return {
            entries: readUint64(view, 32),
            centralDirectorySize: readUint64(view, 40),
            centralDirectoryOffset: readUint64(view, 48),
        };
    }

    private readZip64Extra(extra: Uint8Array, values: {
        compressedSize: number;
        uncompressedSize: number;
        localHeaderOffset: number;
    }): {
        compressedSize: number;
        uncompressedSize: number;
        localHeaderOffset: number;
    } {
        let cursor = 0;
        let compressedSize = values.compressedSize;
        let uncompressedSize = values.uncompressedSize;
        let localHeaderOffset = values.localHeaderOffset;

        while (cursor + 4 <= extra.byteLength) {
            const headerId = extra[cursor] | (extra[cursor + 1] << 8);
            const dataSize = extra[cursor + 2] | (extra[cursor + 3] << 8);
            const dataStart = cursor + 4;
            const dataEnd = dataStart + dataSize;
            if (dataEnd > extra.byteLength) break;

            if (headerId === ZIP64_EXTRA_ID) {
                const view = new DataView(extra.buffer, extra.byteOffset + dataStart, dataSize);
                let zip64Cursor = 0;
                if (uncompressedSize === UINT32_MAX && zip64Cursor + 8 <= dataSize) {
                    uncompressedSize = readUint64(view, zip64Cursor);
                    zip64Cursor += 8;
                }
                if (compressedSize === UINT32_MAX && zip64Cursor + 8 <= dataSize) {
                    compressedSize = readUint64(view, zip64Cursor);
                    zip64Cursor += 8;
                }
                if (localHeaderOffset === UINT32_MAX && zip64Cursor + 8 <= dataSize) {
                    localHeaderOffset = readUint64(view, zip64Cursor);
                }
            }

            cursor = dataEnd;
        }

        return { compressedSize, uncompressedSize, localHeaderOffset };
    }

    private async resolveOffset(rawOffset: number, signature: number, minOffset: number): Promise<number> {
        const maxWraps = Math.ceil(this.blob.size / UINT32_WRAP);

        for (let wrap = 0; wrap <= maxWraps; wrap++) {
            const candidate = rawOffset + wrap * UINT32_WRAP;
            if (candidate < minOffset || candidate + 4 > this.blob.size) continue;
            const candidateSignature = await this.readUint32(candidate);
            if (candidateSignature === signature) return candidate;
        }

        throw new Error(`Invalid ZIP offset for signature ${signature.toString(16)}`);
    }

    private async getDataStart(entry: ZipEntry): Promise<number> {
        const cached = this.dataStartCache.get(entry.name);
        if (cached !== undefined) return cached;

        const header = new Uint8Array(await this.readSlice(entry.localHeaderOffset, 30));
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
        if (view.getUint32(0, true) !== SIG_LOCAL_FILE_HEADER) {
            throw new Error(`Invalid ZIP local file header: ${entry.name}`);
        }
        const nameLength = view.getUint16(26, true);
        const extraLength = view.getUint16(28, true);
        const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
        this.dataStartCache.set(entry.name, dataStart);
        return dataStart;
    }

    private async readUint32(offset: number): Promise<number> {
        const bytes = new Uint8Array(await this.readSlice(offset, 4));
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    }

    private async readSlice(offset: number, length: number): Promise<ArrayBuffer> {
        if (offset < 0 || length < 0 || offset + length > this.blob.size) {
            throw new Error('Invalid ZIP read range');
        }
        try {
            return await readBlobAsArrayBuffer(this.blob.slice(offset, offset + length));
        } catch (error) {
            throw normalizeBackupArchiveError(error);
        }
    }
}
