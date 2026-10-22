import ArrayBufferSlice from "../ArrayBufferSlice.js";
import * as GX from "../gx/gx_enum.js";
import type { TextureInputGX } from "../gx/gx_texture.js";
import { readString } from "../util.js";
import { StrRecord } from "./levelstr.js";

const formats: { [k: number]: GX.TexFormat } = {
    0x10: GX.TexFormat.I4,
    0x11: GX.TexFormat.I8,
    0x12: GX.TexFormat.IA4,
    0x13: GX.TexFormat.IA8,
    0x14: GX.TexFormat.RGB565,
    0x15: GX.TexFormat.RGB5A3,
    0x16: GX.TexFormat.RGBA8,
    0x18: GX.TexFormat.C4,
    0x19: GX.TexFormat.C8,
    0x1E: GX.TexFormat.CMPR,
};

function findTag(bytes: Uint8Array, start: number, end: number, tag: string): number {
    for (let i = start; i + 4 <= end; i++)
        if (bytes[i] === tag.charCodeAt(0) && bytes[i + 1] === tag.charCodeAt(1) && bytes[i + 2] === tag.charCodeAt(2) && bytes[i + 3] === tag.charCodeAt(3))
            return i;
    return -1;
}

function parseSHPG(buffer: ArrayBufferSlice, start: number): TextureInputGX | null {
    const view = buffer.createDataView();
    const bytes = buffer.createTypedArray(Uint8Array);
    if (readString(buffer, start, 4, false) !== 'SHPG')
        return null;
    const name = readString(buffer, start + 0x10, 4, false, 'latin1');
    const e = start + view.getUint32(start + 0x14);
    const format = formats[bytes[e]];
    if (format === undefined)
        return null;
    const blockSize = (bytes[e + 1] << 16) | (bytes[e + 2] << 8) | bytes[e + 3];
    const width = view.getUint16(e + 0x04);
    const height = view.getUint16(e + 0x06);
    const mipCount = (bytes[e + 0x0E] >>> 4) + 1;
    const data = blockSize !== 0 ? buffer.subarray(e + 0x10, blockSize - 0x10) : buffer.slice(e + 0x10);

    let paletteData: ArrayBufferSlice | null = null;
    let paletteFormat = GX.TexPalette.RGB5A3;
    let a = e + blockSize;
    while (blockSize !== 0 && a + 16 <= buffer.byteLength) {
        const code = bytes[a];
        const size = (bytes[a + 1] << 16) | (bytes[a + 2] << 8) | bytes[a + 3];
        if (code === 0x31 || code === 0x32) {
            paletteData = buffer.subarray(a + 0x10, view.getUint16(a + 0x04) * 2);
            paletteFormat = code === 0x31 ? GX.TexPalette.RGB565 : GX.TexPalette.RGB5A3;
        }
        if (size === 0)
            break;
        a += size;
    }

    if ((format === GX.TexFormat.C4 || format === GX.TexFormat.C8) && paletteData === null)
        return null;

    return { name, format, width, height, data, mipCount, paletteFormat, paletteData };
}

export function recordTextureName(id: number): string {
    return `#${(id >>> 0).toString(16).padStart(8, '0')}`;
}

export function parseLevelTextures(records: StrRecord[]): Map<string, TextureInputGX> {
    const textures = new Map<string, TextureInputGX>();
    for (const r of records) {
        const bytes = r.data.createTypedArray(Uint8Array);
        const single = findTag(bytes, 0, Math.min(64, bytes.length), 'SHPG');
        if (single >= 0 && findTag(bytes, 0, single, 'TEX ') < 0) {
            try {
                const tex = parseSHPG(r.data, single);
                if (tex !== null)
                    textures.set(recordTextureName(r.id), { ...tex, name: recordTextureName(r.id) });
            } catch (e) {
                console.warn(`MOHH2: texture record ${r.id.toString(16)} skipped`, e);
            }
            continue;
        }
        const t = findTag(bytes, 0, Math.min(64, bytes.length), 'TEX ');
        if (t < 0)
            continue;
        const view = r.data.createDataView();
        const n = view.getUint32(t + 4, true);
        for (let k = 0; k < n; k++) {
            try {
                const tex = parseSHPG(r.data, t + view.getUint32(t + 8 + 4 * k, true));
                if (tex !== null && !textures.has(tex.name))
                    textures.set(tex.name, tex);
            } catch (e) {
                console.warn(`MOHH2: texture ${k} of record ${r.id.toString(16)} skipped`, e);
            }
        }
    }
    return textures;
}
