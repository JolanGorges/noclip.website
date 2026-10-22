import { vec3 } from "gl-matrix";
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { Billboard } from "./levelstr.js";
import { recordTextureName } from "./textures.js";
import { Attr, baseTileTransforms, compartmentUVScroll, decodeDraw, DecodedDraw, EAGLObject, findDraws, loadCompartment } from "./eagl.js";

export const enum DrawKind { Opaque, AlphaTest, Translucent }

export interface DrawRange {
    indexOffset: number;
    indexCount: number;
    kind: DrawKind;
    baseTexture: string | null;
    maskTexture: string | null;
    lightTexture: string | null;
    sky: boolean;
    prop: boolean;
    cell: boolean;
    scrollUV: [number, number] | null;
    vertexAlpha: boolean;
    spinPivot: vec3 | null;
    billboard: Billboard | null;
    center: vec3;
}

export const VERTEX_FLOATS = 11;

export interface DrawOptions {
    sky?: boolean;
    prop?: boolean;
    cell?: boolean;
    spinPivot?: vec3 | null;
    scrollUV?: [number, number] | null;
}

export class GeometryBuilder {
    private vertices: number[] = [];
    private indices: number[] = [];
    public draws: DrawRange[] = [];
    public min = vec3.fromValues(Infinity, Infinity, Infinity);
    public max = vec3.fromValues(-Infinity, -Infinity, -Infinity);

    public addDraw(d: DecodedDraw, matrix: number[] | null, options: DrawOptions = {}): void {
        const sky = options.sky ?? false, prop = options.prop ?? false, spinPivot = options.spinPivot ?? null;
        const pos = d.arrays.get(Attr.POS);
        if (pos === undefined || d.triangles.length === 0)
            return;
        const slot = (attr: number) => d.attrs.indexOf(attr);
        const posSlot = slot(Attr.POS), clrSlot = slot(Attr.CLR0), tex0Slot = slot(Attr.TEX0), tex1Slot = slot(Attr.TEX1);
        const clr = d.arrays.get(Attr.CLR0), tex0 = d.arrays.get(Attr.TEX0), tex1 = d.arrays.get(Attr.TEX1);

        const first = this.vertices.length / VERTEX_FLOATS;
        const indexOffset = this.indices.length;
        const seen = new Map<string, number>();
        let minAlpha = 1;
        const drawMin = vec3.fromValues(Infinity, Infinity, Infinity), drawMax = vec3.fromValues(-Infinity, -Infinity, -Infinity);
        for (const v of d.triangles) {
            const key = v.join(',');
            let index = seen.get(key);
            if (index === undefined) {
                index = this.vertices.length / VERTEX_FLOATS - first;
                seen.set(key, index);

                const p = v[posSlot] * 3;
                let x = pos.data[p + 0], y = pos.data[p + 1], z = pos.data[p + 2];
                if (matrix !== null) {
                    const m = matrix;
                    [x, y, z] = [
                        x * m[0] + y * m[3] + z * m[6] + m[9],
                        x * m[1] + y * m[4] + z * m[7] + m[10],
                        x * m[2] + y * m[5] + z * m[8] + m[11],
                    ];
                }
                this.vertices.push(x, z, -y);
                vec3.min(drawMin, drawMin, [x, z, -y]);
                vec3.max(drawMax, drawMax, [x, z, -y]);
                if (!sky) {
                    vec3.min(this.min, this.min, [x, z, -y]);
                    vec3.max(this.max, this.max, [x, z, -y]);
                }

                if (clr !== undefined && clrSlot >= 0 && v[clrSlot] * 4 < clr.data.length) {
                    this.vertices.push(clr.data[v[clrSlot] * 4], clr.data[v[clrSlot] * 4 + 1], clr.data[v[clrSlot] * 4 + 2], clr.data[v[clrSlot] * 4 + 3]);
                    minAlpha = Math.min(minAlpha, clr.data[v[clrSlot] * 4 + 3]);
                }
                else
                    this.vertices.push(0.5, 0.5, 0.5, 1.0);
                for (const [arr, s] of [[tex0, tex0Slot], [tex1, tex1Slot]] as const) {
                    if (arr !== undefined && s >= 0 && v[s] * 2 < arr.data.length)
                        this.vertices.push(arr.data[v[s] * 2], arr.data[v[s] * 2 + 1]);
                    else
                        this.vertices.push(0, 0);
                }
            }
            this.indices.push(first + index);
        }

        let kind = DrawKind.Opaque;
        if (d.shader.includes('OneBitAlpha'))
            kind = DrawKind.AlphaTest;
        else if (d.shader.includes('AnimUV'))
            kind = DrawKind.Translucent;
        const maskTexture = d.shader.includes('SplitAlpha') && d.textures.length > 1 ? d.textures[1] : null;
        const lightTexture = d.shader.includes('ShadowMap') && d.attrs.includes(Attr.TEX1) ? d.textures[d.textures.length - 1] ?? null : null;
        const center = vec3.lerp(vec3.create(), drawMin, drawMax, 0.5);
        this.draws.push({ indexOffset, indexCount: this.indices.length - indexOffset, kind, baseTexture: d.textures[0] ?? null, maskTexture, lightTexture, sky, prop, scrollUV: d.shader.includes('AnimUV') ? options.scrollUV ?? null : null, spinPivot, vertexAlpha: minAlpha < 0.99, cell: options.cell ?? false, billboard: null, center });
    }

    public addBillboard(b: Billboard, texture: string): void {
        const m = b.matrix;
        const center = vec3.fromValues(m[9], m[11], -m[10]);
        const first = this.vertices.length / VERTEX_FLOATS;
        const indexOffset = this.indices.length;
        const color = b.color.map((c) => c / 255);
        const corners = [[0, 1, -1, -1], [1, 1, 1, -1], [1, 0, 1, 1], [0, 0, -1, 1]];
        for (const [u, v, sx, sy] of corners)
            this.vertices.push(center[0], center[1], center[2], color[0], color[1], color[2], color[3], u, v, sx * b.width / 2, sy * b.height / 2);
        this.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
        this.draws.push({
            indexOffset, indexCount: 6, kind: DrawKind.Translucent, baseTexture: texture, maskTexture: null, lightTexture: null,
            sky: false, prop: false, scrollUV: null, spinPivot: null, vertexAlpha: false, cell: false, billboard: b, center,
        });
    }

    public get vertexData(): Float32Array { return new Float32Array(this.vertices); }
    public get indexData(): Uint32Array { return new Uint32Array(this.indices); }
}

function decodeObject(obj: EAGLObject): DecodedDraw[] {
    const out: DecodedDraw[] = [];
    for (const draw of findDraws(obj)) {
        try {
            out.push(decodeDraw(obj, draw));
        } catch (e) {
            console.warn(`MOHH2: draw in ${obj.modelName()} skipped`, e);
        }
    }
    return out;
}

export function buildLevelGeometry(files: Map<string, ArrayBufferSlice>, skybox: EAGLObject[], props: { objects: EAGLObject[], matrix: number[], spin: boolean }[], billboards: Billboard[] = []): GeometryBuilder {
    const xml = new TextDecoder('latin1').decode(files.get('comp_stream_data.xml')!.createTypedArray(Uint8Array));
    const base = /basedetail cpt="[^"]*?\/(CMP\d+\/[^"/]+)\.cpt"/.exec(xml)![1];
    const cells = [...xml.matchAll(/<cell i="(\d+)" cpt="[^"]*?\/(CMP\d+\/[^"/]+)\.cpt"/g)].map((m) => m[2]);

    const builder = new GeometryBuilder();

    const cpt = files.get(`${base}.cpt`)!;
    const objects = loadCompartment(cpt, files.get(`${base}.rtc`)!);
    const decoded = objects.map(decodeObject);
    const names = objects.map((o) => o.modelName() ?? '?');
    const bounds = decoded.map((draws) => {
        let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const d of draws) {
            const p = d.arrays.get(Attr.POS);
            if (p === undefined)
                continue;
            for (let i = 0; i < p.data.length; i += 3)
                for (let c = 0; c < 3; c++) {
                    min[c] = Math.min(min[c], p.data[i + c]);
                    max[c] = Math.max(max[c], p.data[i + c]);
                }
        }
        return min[0] <= max[0] ? { min, max } : null;
    });
    const tiles = baseTileTransforms(cpt, bounds, names);
    const baseScroll = compartmentUVScroll(cpt);
    decoded.forEach((draws, m) => {
        const tile = tiles.get(m);
        if (tile === undefined)
            return;
        const matrix = [tile.scale[0], 0, 0, 0, tile.scale[1], 0, 0, 0, tile.scale[2], tile.offset[0], tile.offset[1], tile.offset[2]];
        for (const d of draws)
            builder.addDraw(d, matrix, { scrollUV: baseScroll.get(m) });
    });

    for (const path of cells) {
        const c = files.get(`${path}.cpt`), r = files.get(`${path}.rtc`);
        if (c === undefined || r === undefined)
            continue;
        const scroll = compartmentUVScroll(c);
        loadCompartment(c, r).forEach((obj, m) => {
            for (const d of decodeObject(obj))
                builder.addDraw(d, null, { scrollUV: scroll.get(m), cell: true });
        });
    }

    const decodedProps = new Map<EAGLObject, DecodedDraw[]>();
    for (const prop of props) {
        const m = prop.matrix;
        const pivot = prop.spin ? vec3.fromValues(m[9], m[11], -m[10]) : null;
        for (const obj of prop.objects) {
            if (!decodedProps.has(obj))
                decodedProps.set(obj, decodeObject(obj));
            for (const d of decodedProps.get(obj)!)
                builder.addDraw(d, prop.matrix, { prop: true, spinPivot: pivot });
        }
    }

    for (const b of billboards)
        builder.addBillboard(b, recordTextureName(b.texture));

    for (const obj of skybox)
        for (const d of decodeObject(obj))
            builder.addDraw(d, null, { sky: true });

    return builder;
}
