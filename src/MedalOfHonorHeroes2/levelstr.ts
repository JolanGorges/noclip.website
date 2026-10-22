import * as CRC32 from "crc-32";
import ArrayBufferSlice from "../ArrayBufferSlice.js";
import { EAGLObject } from "./eagl.js";

export interface StrRecord {
    id: number;
    type: number;
    data: ArrayBufferSlice;
}

export interface StrField {
    hash: number;
    type: number;
    data: ArrayBufferSlice;
}

export function parseStrRecords(str: ArrayBufferSlice): StrRecord[] {
    const view = str.createDataView();
    const groupCount = view.getUint32(20);
    let total = 0;
    for (let i = 0; i < groupCount; i++)
        total += view.getUint32(28 + 8 * i);

    const records: StrRecord[] = [];
    let o = 24 + 8 * groupCount;
    for (let i = 0; i < total; i++) {
        const length = view.getUint32(o + 8);
        records.push({ id: view.getUint32(o + 0), type: view.getUint32(o + 4), data: str.slice(o + 12, o + length) });
        o += length;
    }
    return records;
}

export function parseStrFields(record: StrRecord): StrField[] {
    const view = record.data.createDataView();
    const count = view.getUint32(4);
    const fields: StrField[] = [];
    let o = 8;
    for (let i = 0; i < count; i++) {
        const size = view.getUint32(o + 8);
        fields.push({ hash: view.getUint32(o + 0), type: view.getUint32(o + 4), data: record.data.subarray(o + 12, size) });
        o += 12 + size;
    }
    return fields;
}

const enum RecordType {
    RelocationTable = 0x4C8FA6D7,
    Skybox = 0x9A5872D8,
    Entities = 0xEC5D66B5,
    ObjectDefinition = 0x2CE479D1,
    PickupModel = 0x9C43602F,
    Weapon = 0x7638FD53,
    Billboard = 0x8724D2D2,
}

const enum FieldHash {
    State = 0xA393D2FB,
    StateMesh = 0xFD912A15,
    StateEvents = 0xB28276EA,
    PickupMesh = 0x415D9568,
    WeaponModel = 0x89F08A82,
}

function loadSplitObjects(blob: ArrayBufferSlice, relocations: Map<number, Uint8Array>): EAGLObject[] {
    const view = blob.createDataView();
    const bytes = blob.createTypedArray(Uint8Array);
    const objects: EAGLObject[] = [];
    for (let k = 0; k < 2; k++) {
        const offs = view.getUint32(0x14 + 8 * k);
        const size = view.getUint32(0x18 + 8 * k);
        if (size === 0)
            continue;
        const rtc = relocations.get(view.getUint32(0x38 + 4 * k));
        if (rtc === undefined)
            continue;
        objects.push(new EAGLObject(bytes.subarray(offs, offs + size), rtc));
    }
    return objects;
}

function loadRelocations(records: StrRecord[]): Map<number, Uint8Array> {
    const relocations = new Map<number, Uint8Array>();
    const record = records.find((r) => r.type === RecordType.RelocationTable);
    if (record === undefined)
        return relocations;
    const rtc = parseStrFields(record)[0].data;
    const view = rtc.createDataView();
    const bytes = rtc.createTypedArray(Uint8Array);
    const count = view.getUint32(0x10);
    for (let i = 0; i < count; i++) {
        const id = view.getUint32(0x18 + 12 * i + 0x00);
        const offs = view.getUint32(0x18 + 12 * i + 0x04);
        const size = view.getUint32(0x18 + 12 * i + 0x08);
        relocations.set(id, bytes.subarray(offs, offs + size));
    }
    return relocations;
}

export function loadSkybox(records: StrRecord[]): EAGLObject[] {
    const relocations = loadRelocations(records);
    const objects: EAGLObject[] = [];
    for (const record of records)
        if (record.type === RecordType.Skybox)
            objects.push(...loadSplitObjects(parseStrFields(record)[0].data, relocations));
    return objects;
}

export interface Placement {
    name: string;
    className: string;
    definition: string;
    matrix: number[];
}

export function parseEntities(records: StrRecord[]): Placement[] {
    const record = records.find((r) => r.type === RecordType.Entities);
    if (record === undefined)
        return [];
    const blob = parseStrFields(record)[0].data;
    const view = blob.createDataView();
    const bytes = blob.createTypedArray(Uint8Array);

    const marker = new TextEncoder().encode('STRING TABLE START');
    let tableOffs = -1;
    for (let i = 0; i + marker.length <= bytes.length && tableOffs < 0; i++)
        if (marker.every((c, k) => bytes[i + k] === c))
            tableOffs = i;
    if (tableOffs < 0)
        return [];
    const strings: string[] = [];
    for (let o = tableOffs; o < bytes.length;) {
        let e = o;
        while (e < bytes.length && bytes[e] !== 0)
            e++;
        strings.push(new TextDecoder('latin1').decode(bytes.subarray(o, e)));
        o = e + 1;
    }
    const str = (i: number) => strings[i] ?? '';

    const placements: Placement[] = [];
    const end = view.getUint32(0x40, true);
    for (let o = view.getUint32(0x48, true); o + 0x40 <= end;) {
        const size = view.getUint32(o + 0x08, true);
        if (size < 0x40)
            break;
        const matrix: number[] = [];
        for (let k = 0; k < 12; k++)
            matrix.push(view.getFloat32(o + 0x0C + 4 * k, true));
        placements.push({ name: str(view.getUint32(o + 0x00, true)), className: str(view.getUint32(o + 0x04, true)), definition: str(view.getUint32(o + 0x3C, true)), matrix });
        o += size;
    }
    return placements;
}

function fieldRefs(record: StrRecord, hash: number): number[] {
    const refs: number[] = [];
    for (const f of parseStrFields(record))
        if (f.type === 6 && f.hash === hash)
            refs.push(f.data.createDataView().getUint32(0));
    return refs;
}

const placedClasses = ['WeaponPowerup', 'SmartObject'];
const ignoredClasses = ['DynamicLightTuning', 'PlayerTuning', 'AnimLightDef'];

export function resolvePlacedModels(records: StrRecord[], placements: Placement[]): { placement: Placement, objects: EAGLObject[] }[] {
    const relocations = loadRelocations(records);
    const byId = new Map<number, StrRecord>();
    for (const r of records)
        byId.set(r.id, r);

    const meshCache = new Map<number, EAGLObject[]>();
    const meshObjects = (id: number): EAGLObject[] => {
        let objects = meshCache.get(id);
        if (objects === undefined) {
            const r = byId.get(id);
            objects = r !== undefined ? loadSplitObjects(parseStrFields(r)[0].data, relocations) : [];
            meshCache.set(id, objects);
        }
        return objects;
    };

    const resolve = (id: number): number | null => {
        const r = byId.get(id);
        if (r === undefined)
            return null;
        if (r.type === RecordType.ObjectDefinition) {
            const states = fieldRefs(r, FieldHash.State).map((id) => byId.get(id)).filter((s) => s !== undefined) as StrRecord[];
            const withMesh = states.filter((s) => fieldRefs(s, FieldHash.StateMesh).length > 0);
            const initial = withMesh.find((s) => fieldRefs(s, FieldHash.StateEvents).length > 0) ?? withMesh[0];
            if (initial !== undefined)
                return fieldRefs(initial, FieldHash.StateMesh)[0];
        } else if (r.type === RecordType.PickupModel) {
            return fieldRefs(r, FieldHash.PickupMesh)[0] ?? null;
        } else if (r.type === RecordType.Weapon) {
            return fieldRefs(r, FieldHash.WeaponModel)[0] ?? null;
        }
        return null;
    };

    const out: { placement: Placement, objects: EAGLObject[] }[] = [];
    for (const placement of placements) {
        const leaf = placement.definition.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '');
        const isObject = /\.sob$/i.test(placement.definition);
        if (leaf === '' || ignoredClasses.includes(placement.className) || (!isObject && placement.className !== leaf && !placedClasses.includes(placement.className)))
            continue;
        const mesh = resolve(CRC32.str(leaf) >>> 0);
        if (mesh === null)
            continue;
        const objects = meshObjects(mesh);
        if (objects.length > 0)
            out.push({ placement, objects });
    }
    return out;
}

export interface Billboard {
    matrix: number[];
    texture: number;
    width: number;
    height: number;
    color: [number, number, number, number];
    nearClip: number;
    nearFade: number;
    farFade: number;
    farClip: number;
    zBias: number;
    axisType: number;
}

function fieldValues(record: StrRecord): Map<number, StrField> {
    const fields = new Map<number, StrField>();
    for (const f of parseStrFields(record))
        fields.set(f.hash, f);
    return fields;
}

const nameHash = (name: string) => CRC32.str(name) >>> 0;

export function resolveBillboards(records: StrRecord[], placements: Placement[]): Billboard[] {
    const byId = new Map<number, StrRecord>();
    for (const r of records)
        byId.set(r.id, r);

    const out: Billboard[] = [];
    for (const placement of placements) {
        if (placement.className !== 'BillboardObject')
            continue;
        const leaf = placement.definition.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '');
        const record = byId.get(nameHash(leaf));
        if (record === undefined || record.type !== RecordType.Billboard)
            continue;
        const fields = fieldValues(record);
        const num = (name: string, fallback: number) => {
            const f = fields.get(nameHash(name));
            if (f === undefined)
                return fallback;
            const v = f.data.createDataView();
            return f.type === 1 ? v.getFloat32(0) : v.getInt32(0);
        };
        const texture = fields.get(nameHash('Texture')) ?? parseStrFields(record).find((f) => f.type === 6);
        if (texture === undefined)
            continue;
        out.push({
            matrix: placement.matrix,
            texture: texture.data.createDataView().getUint32(0),
            width: num('SizeWidth', 1),
            height: num('SizeHeight', 1),
            color: [num('ColorR', 128), num('ColorG', 128), num('ColorB', 128), num('Alpha', 128)],
            nearClip: num('NearClip', 0),
            nearFade: num('NearFade', 0),
            farFade: num('FarFade', 1e6),
            farClip: num('FarClip', 1e6),
            zBias: num('ZBias', 0),
            axisType: num('AxisType', 0),
        });
    }
    return out;
}
