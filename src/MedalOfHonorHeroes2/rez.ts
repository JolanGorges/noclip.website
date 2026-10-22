import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { assert, readString } from "../util.js";

function decompressLZSS(src: Uint8Array, size: number): Uint8Array {
    const dst = new Uint8Array(size);
    let o = 0, i = 0, bits = 1;
    while (o < size && i < src.length) {
        if (bits === 1) {
            bits = src[i++] | 0x100;
            if (i >= src.length)
                break;
        }
        if (bits & 1) {
            dst[o++] = src[i++];
        } else {
            const tok = src[i] | (src[i + 1] << 8);
            i += 2;
            let s = o - (0x1000 - (tok & 0xFFF));
            const n = (tok >>> 12) + 3;
            for (let k = 0; k < n && o < size; k++)
                dst[o++] = dst[s++];
        }
        bits >>>= 1;
    }
    return dst;
}

function decompressRLE(src: Uint8Array, size: number): Uint8Array {
    const dst = new Uint8Array(size);
    let o = 0, i = 0;
    while (o < size && i < src.length) {
        const t = src[i++];
        if (t <= 0x7F) {
            for (let k = 0; k <= t && o < size; k++)
                dst[o++] = src[i + k];
            i += t + 1;
        } else {
            const v = src[i++];
            for (let k = 0; k < 0x101 - t && o < size; k++)
                dst[o++] = v;
        }
    }
    return dst;
}

export function parseRez(buffer: ArrayBufferSlice): Map<string, ArrayBufferSlice> {
    assert(readString(buffer, 0, 4, false) === 'BRGR');
    const view = buffer.createDataView();
    const count = view.getUint32(0x1C, true);
    const entries: [string, ArrayBufferSlice][] = [];
    for (let k = 0; k < count; k++) {
        const entry = 0x20 + k * 0x10;
        const offs = view.getUint32(entry + 0x00, true);
        const size = view.getUint32(entry + 0x04, true);
        const nameOffs = view.getUint16(entry + 0x08, true);
        const flags = view.getUint16(entry + 0x0A, true);
        const packedSize = view.getUint32(entry + 0x0C, true);
        const name = readString(buffer, 0x18 + nameOffs).replace(/\\/g, '/');
        const raw = buffer.subarray(offs, packedSize);
        let data: ArrayBufferSlice;
        if (flags === 0)
            data = raw;
        else if (flags === 8)
            data = new ArrayBufferSlice(decompressLZSS(raw.createTypedArray(Uint8Array), size).buffer);
        else
            data = new ArrayBufferSlice(decompressRLE(raw.createTypedArray(Uint8Array), size).buffer);
        entries.push([name, data]);
    }

    let prefix = entries[0][0];
    for (const [name] of entries)
        while (!name.startsWith(prefix))
            prefix = prefix.slice(0, -1);
    prefix = prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '';

    const files = new Map<string, ArrayBufferSlice>();
    for (const [name, data] of entries)
        files.set(name.slice(prefix.length), data);
    return files;
}
