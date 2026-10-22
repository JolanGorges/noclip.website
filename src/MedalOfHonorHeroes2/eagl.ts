import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { readString } from "../util.js";

export type Pointer = { kind: 'data', target: number } | { kind: 'sym', name: string, addend: number };

interface Section {
    nameOffs: number;
    type: number;
    offs: number;
    size: number;
    link: number;
    name: string;
}

interface Symbol {
    name: string;
    value: number;
    shndx: number;
}

export class EAGLObject {
    public data: DataView;
    public dataBytes: Uint8Array;
    public symbols: Symbol[] = [];
    public pointers = new Map<number, Pointer>();

    constructor(cptBlock: Uint8Array, rtcEntry: Uint8Array) {
        const elf = new Uint8Array(cptBlock.length + rtcEntry.length);
        elf.set(cptBlock, 0);
        elf.set(rtcEntry, cptBlock.length);
        const slice = new ArrayBufferSlice(elf.buffer);
        const view = slice.createDataView();

        const shoff = view.getUint32(0x20, true);
        const shentsize = view.getUint16(0x2E, true);
        const shnum = view.getUint16(0x30, true);
        const shstrndx = view.getUint16(0x32, true);
        const sections: Section[] = [];
        for (let k = 0; k < shnum; k++) {
            const h = shoff + k * shentsize;
            sections.push({
                nameOffs: view.getUint32(h + 0x00, true),
                type: view.getUint32(h + 0x04, true),
                offs: view.getUint32(h + 0x10, true),
                size: view.getUint32(h + 0x14, true),
                link: view.getUint32(h + 0x18, true),
                name: '',
            });
        }
        const shstr = sections[shstrndx];
        for (const s of sections)
            s.name = readString(slice, shstr.offs + s.nameOffs);

        const dataIndex = sections.findIndex((s) => s.name === '.data');
        const dataSection = sections[dataIndex];
        this.dataBytes = elf.slice(dataSection.offs, dataSection.offs + dataSection.size);
        this.data = new DataView(this.dataBytes.buffer);

        for (const s of sections) {
            if (s.type !== 2)
                continue;
            const strs = sections[s.link];
            for (let j = 0; j < s.size / 16; j++) {
                const e = s.offs + j * 16;
                this.symbols.push({
                    name: readString(slice, strs.offs + view.getUint32(e + 0x00, true), -1, true, 'latin1'),
                    value: view.getUint32(e + 0x04, true),
                    shndx: view.getUint16(e + 0x0E, true),
                });
            }
        }

        for (const s of sections) {
            if (s.type !== 9 || s.name !== '.rel.data')
                continue;
            for (let j = 0; j < s.size / 8; j++) {
                const offs = view.getUint32(s.offs + j * 8 + 0x00, true);
                const info = view.getUint32(s.offs + j * 8 + 0x04, true);
                const sym = this.symbols[info >>> 8];
                const addend = this.data.getUint32(offs, true);
                if (sym.shndx === dataIndex)
                    this.pointers.set(offs, { kind: 'data', target: sym.value + addend });
                else
                    this.pointers.set(offs, { kind: 'sym', name: sym.name, addend });
            }
        }
    }

    public modelName(): string | null {
        const sym = this.symbols.find((s) => s.name.startsWith('__Model'));
        return sym !== undefined ? sym.name.split(':::')[1] : null;
    }
}

export function loadCompartment(cpt: ArrayBufferSlice, rtc: ArrayBufferSlice): EAGLObject[] {
    const c = cpt.createDataView();
    const r = rtc.createDataView();
    const cptBytes = cpt.createTypedArray(Uint8Array);
    const rtcBytes = rtc.createTypedArray(Uint8Array);
    const n = c.getUint32(0x94);
    const objects: (EAGLObject | null)[] = new Array(n).fill(null);
    const entryCount = r.getUint32(0x10);
    for (let i = 0; i < entryCount; i++) {
        const id = r.getUint32(0x18 + 12 * i + 0x00);
        const offs = r.getUint32(0x18 + 12 * i + 0x04);
        const size = r.getUint32(0x18 + 12 * i + 0x08);
        const blockOffs = c.getUint32(0x98 + 8 * id + 0x00);
        const blockSize = c.getUint32(0x98 + 8 * id + 0x04);
        objects[id] = new EAGLObject(cptBytes.subarray(blockOffs, blockOffs + blockSize), rtcBytes.subarray(offs, offs + size));
    }
    return objects.filter((o) => o !== null) as EAGLObject[];
}

export const enum Attr { POS = 9, NRM = 10, CLR0 = 11, CLR1 = 12, TEX0 = 13, TEX1 = 14 }

export interface DrawRecord {
    shader: string;
    displayListOffs: number;
    displayListSize: number;
    attrs: { fmt: number, attr: number }[];
    params: { count: number, ptr: Pointer }[];
}

export function findDraws(obj: EAGLObject): DrawRecord[] {
    const draws: DrawRecord[] = [];
    const slots = [...obj.pointers.keys()].sort((a, b) => a - b);
    for (const slot of slots) {
        const p = obj.pointers.get(slot)!;
        if (p.kind !== 'sym' || !p.name.startsWith('Moh_'))
            continue;
        const self = obj.pointers.get(slot + 4);
        if (self === undefined || self.kind !== 'data')
            continue;

        let dl = -1;
        for (let k = self.target; k < slot; k++) {
            const q = obj.pointers.get(k);
            if (q !== undefined && q.kind === 'data') {
                dl = k;
                break;
            }
        }
        if (dl < 0)
            continue;

        const dlPtr = obj.pointers.get(dl)! as { kind: 'data', target: number };
        const attrs: { fmt: number, attr: number }[] = [];
        let j = dl + 8;
        while (obj.dataBytes[j] !== 0) {
            attrs.push({ fmt: obj.dataBytes[j], attr: obj.dataBytes[j + 1] });
            j += 2;
        }

        const params: { count: number, ptr: Pointer }[] = [];
        j = slot + 8;
        while (j + 8 <= obj.dataBytes.length && obj.pointers.has(j + 4)) {
            params.push({ count: obj.data.getUint32(j), ptr: obj.pointers.get(j + 4)! });
            j += 8;
        }

        draws.push({ shader: p.name, displayListOffs: dlPtr.target, displayListSize: obj.data.getUint32(dl + 4), attrs, params });
    }
    return draws;
}

export interface DecodedDraw {
    shader: string;
    textures: string[];
    attrs: number[];
    arrays: Map<number, { data: Float32Array, components: number }>;
    triangles: number[][];
}

function readArray(obj: EAGLObject, offs: number, count: number, stride: number, attr: number): { data: Float32Array, components: number } {
    const v = obj.data;
    const components = (attr === Attr.POS || attr === Attr.NRM) ? 3 : (attr === Attr.CLR0 || attr === Attr.CLR1) ? 4 : 2;
    const out = new Float32Array(count * components);
    for (let i = 0; i < count; i++) {
        for (let c = 0; c < components; c++) {
            let value: number;
            if (attr === Attr.CLR0 || attr === Attr.CLR1)
                value = v.getUint8(offs + i * 4 + c) / 255;
            else if (stride === components * 4)
                value = v.getFloat32(offs + i * stride + c * 4);
            else if (stride === components * 2)
                value = v.getInt16(offs + i * stride + c * 2) / (attr === Attr.POS ? 256 : attr === Attr.NRM ? 16384 : 1024);
            else
                value = v.getInt8(offs + i * stride + c) / 64;
            out[i * components + c] = value;
        }
    }
    return { data: out, components };
}

export function decodeDraw(obj: EAGLObject, draw: DrawRecord): DecodedDraw {
    const params = draw.params;
    let matrixIndex = -1;
    params.forEach((p, i) => {
        if (p.ptr.kind === 'sym' && p.ptr.name.startsWith('__MATRIX4'))
            matrixIndex = i;
    });
    const arrayParams = params.slice(matrixIndex + 1, matrixIndex + 1 + draw.attrs.length);
    const textures: string[] = [];
    for (const p of params)
        if (p.ptr.kind === 'sym' && p.ptr.name.includes('TAR:::'))
            textures.push(p.ptr.name.split('1=')[1].split(',')[0]);

    const arrays = new Map<number, { data: Float32Array, components: number }>();
    draw.attrs.forEach(({ attr }, i) => {
        const p = arrayParams[i];
        if (p === undefined || p.ptr.kind !== 'data')
            return;
        const stride = attr === Attr.POS ? 12 : attr === Attr.NRM ? 6 : (attr === Attr.CLR0 || attr === Attr.CLR1) ? 4 : 8;
        arrays.set(attr, readArray(obj, p.ptr.target, p.count, stride, attr));
    });

    const b = obj.dataBytes.subarray(draw.displayListOffs, draw.displayListOffs + draw.displayListSize);
    const indexSizes = draw.attrs.map(({ fmt }) => fmt === 9 ? 2 : 1);
    const vertexSize = indexSizes.reduce((a, s) => a + s, 0);
    const triangles: number[][] = [];
    let i = 0;
    while (i + 3 <= b.length) {
        const op = b[i];
        if (op === 0) {
            i++;
            continue;
        }
        const prim = op & 0xF8;
        if (prim !== 0x80 && prim !== 0x90 && prim !== 0x98 && prim !== 0xA0)
            break;
        const n = (b[i + 1] << 8) | b[i + 2];
        i += 3;
        const verts: number[][] = [];
        for (let k = 0; k < n; k++) {
            const vtx: number[] = [];
            let o = i;
            for (const s of indexSizes) {
                vtx.push(s === 1 ? b[o] : (b[o] << 8) | b[o + 1]);
                o += s;
            }
            verts.push(vtx);
            i += vertexSize;
        }
        if (prim === 0x90) {
            for (let j = 0; j + 2 < n; j += 3)
                triangles.push(verts[j], verts[j + 1], verts[j + 2]);
        } else if (prim === 0x98) {
            for (let j = 0; j + 2 < n; j++) {
                if (j % 2 === 0)
                    triangles.push(verts[j], verts[j + 1], verts[j + 2]);
                else
                    triangles.push(verts[j + 1], verts[j], verts[j + 2]);
            }
        } else if (prim === 0xA0) {
            for (let j = 1; j + 1 < n; j++)
                triangles.push(verts[0], verts[j], verts[j + 1]);
        } else {
            for (let j = 0; j + 3 < n; j += 4)
                triangles.push(verts[j], verts[j + 1], verts[j + 2], verts[j], verts[j + 2], verts[j + 3]);
        }
    }

    return { shader: draw.shader, textures, attrs: draw.attrs.map((a) => a.attr), arrays, triangles };
}

export interface TileTransform {
    scale: [number, number, number];
    offset: [number, number, number];
}

interface QuadtreeGroup {
    start: number;
    end: number;
    rootCenter: number[];
    rootHalf: number[];
    leaves: Map<number, { center: number[], half: number[] }>;
}

function pow2AtLeast(v: number): number {
    let p = 1.0;
    while (p < v - 1e-6)
        p *= 2;
    return p;
}

function roundHalfEven(v: number): number {
    const r = Math.round(v);
    return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}

function median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >>> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quadtreeGroups(cpt: ArrayBufferSlice): QuadtreeGroup[] {
    const v = cpt.createDataView();
    const table = v.getUint32(0x3C);
    const n = v.getUint32(table);
    const starts = [0];
    for (let k = 0; k < n; k++)
        starts.push(v.getUint32(0x64 + 4 * k));
    const groups: QuadtreeGroup[] = [];
    for (let g = 0; g < n; g++) {
        const offs = v.getUint32(table + 4 + 8 * g + 0x00);
        const size = v.getUint32(table + 4 + 8 * g + 0x04);
        const group: QuadtreeGroup = { start: starts[g], end: starts[g + 1], rootCenter: [0, 0, 0], rootHalf: [0, 0, 0], leaves: new Map() };
        for (let i = offs; i < offs + size - 0x47; i += 0x48) {
            const half = [v.getFloat32(i + 0x00), v.getFloat32(i + 0x04), v.getFloat32(i + 0x08)];
            const center = [v.getFloat32(i + 0x30), v.getFloat32(i + 0x34), v.getFloat32(i + 0x38)];
            const flag = v.getInt32(i + 0x3C);
            if (i === offs) {
                group.rootCenter = center;
                group.rootHalf = half;
            }
            if (flag >= 0 && flag < 100000 && half[0] > 0)
                group.leaves.set(starts[g] + flag, { center, half });
        }
        groups.push(group);
    }
    return groups;
}

function fitTileAxis(tiles: number[], offsets: number[]): { origin: number, step: number } {
    if (new Set(tiles).size < 2)
        return { origin: median(offsets), step: 0 };
    const n = tiles.length;
    const mx = tiles.reduce((s, x) => s + x, 0) / n;
    const my = offsets.reduce((s, y) => s + y, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
        sxy += (tiles[i] - mx) * (offsets[i] - my);
        sxx += (tiles[i] - mx) ** 2;
    }
    const step = Math.round(sxy / sxx * 2) / 2;
    return { origin: median(tiles.map((x, i) => offsets[i] - step * x)), step };
}

export function baseTileTransforms(cpt: ArrayBufferSlice, localBounds: ({ min: number[], max: number[] } | null)[], names: string[]): Map<number, TileTransform> {
    const result = new Map<number, TileTransform>();
    for (const g of quadtreeGroups(cpt)) {
        const tiles = new Map<number, number[]>();
        for (let m = g.start; m < g.end; m++) {
            const match = /_(\d+)_(\d+)_\d+$/.exec(names[m]);
            if (localBounds[m] && match !== null)
                tiles.set(m, [parseInt(match[1], 10), parseInt(match[2], 10)]);
        }
        const withLeaf = [...tiles.keys()].filter((m) => g.leaves.has(m));
        if (withLeaf.length === 0)
            continue;

        const localHalf = (m: number, c: number) => (localBounds[m]!.max[c] - localBounds[m]!.min[c]) / 2;
        const localCenter = (m: number, c: number) => (localBounds[m]!.max[c] + localBounds[m]!.min[c]) / 2;
        const scaleXY = [0, 1].map((c) => {
            const ratio = median(withLeaf.map((m) => g.leaves.get(m)!.half[c] / Math.max(localHalf(m, c), 1e-6)));
            return 2 ** roundHalfEven(Math.log2(ratio));
        });
        const scaleZ = pow2AtLeast(g.rootHalf[2]);
        const grid = [0, 1].map((c) => fitTileAxis(
            withLeaf.map((m) => tiles.get(m)![c]),
            withLeaf.map((m) => g.leaves.get(m)!.center[c] - localCenter(m, c) * scaleXY[c])));

        for (const [m, tile] of tiles) {
            const center = [0, 1].map((c) => grid[c].origin + grid[c].step * tile[c]);
            result.set(m, { scale: [scaleXY[0], scaleXY[1], scaleZ], offset: [center[0], center[1], g.rootCenter[2]] });
        }
    }
    return result;
}

const MATERIAL_ANIM_TICKS_PER_SECOND = 120;

export function compartmentUVScroll(cpt: ArrayBufferSlice): Map<number, [number, number]> {
    const v = cpt.createDataView();
    const scroll = new Map<number, [number, number]>();
    const table = v.getUint32(0x5C);
    if (table === 0)
        return scroll;
    const count = v.getUint32(table);
    for (let i = 0; i < count; i++) {
        const entry = v.getUint32(table + 4 + 4 * i);
        const u = v.getFloat32(entry + 0x18) * MATERIAL_ANIM_TICKS_PER_SECOND;
        const w = v.getFloat32(entry + 0x1C) * MATERIAL_ANIM_TICKS_PER_SECOND;
        scroll.set(v.getUint32(entry + 0x24), [u, w]);
    }
    return scroll;
}
