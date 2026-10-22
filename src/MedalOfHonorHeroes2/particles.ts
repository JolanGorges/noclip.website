import * as CRC32 from "crc-32";
import { vec3 } from "gl-matrix";
import { parseStrFields, Placement, StrRecord } from "./levelstr.js";

type Vec3 = [number, number, number];

export interface Emitter {
    matrix: number[];
    texture: number;
    additive: boolean;
    rate: number;
    lifeBase: number;
    lifeVariance: number;
    posBase: Vec3;
    posVariance: Vec3;
    velBase: Vec3;
    velVariance: Vec3;
    accBase: Vec3;
    accVariance: Vec3;
    sizeBase: number;
    sizeVariance: number;
    sizeVelBase: number;
    sizeVelVariance: number;
    sizeAccBase: number;
    sizeAccVariance: number;
    rotate: boolean;
    rotBase: number;
    rotVariance: number;
    rotVelBase: number;
    rotVelVariance: number;
    rotAccBase: number;
    rotAccVariance: number;
    colorKeys: { time: number, color: [number, number, number, number] }[];
    fadeIn: number;
    fadeOut: number;
    scale: number;
    seed: number;
}

const enum RecordType {
    Effect = 0xDB93F8AD,
}

const enum FieldHash {
    Definition = 0x3A6F80DE,
    Texture = 0x81728B86,
}

function parseLion(text: string): Map<string, string>[] {
    const emitters: Map<string, string>[] = [];
    let current: Map<string, string> | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('<DESCRIPTOR')) {
            current = new Map();
            emitters.push(current);
            continue;
        }
        const eq = line.indexOf(' = ');
        if (current !== null && eq > 0)
            current.set(line.slice(0, eq).trim(), line.slice(eq + 3).trim());
    }
    return emitters;
}

function numbers(m: Map<string, string>, key: string, count: number): number[] {
    const values = (m.get(key) ?? '').split(',').map((s) => parseFloat(s));
    const out: number[] = [];
    for (let i = 0; i < count; i++)
        out.push(Number.isFinite(values[i]) ? values[i] : 0);
    return out;
}

const num = (m: Map<string, string>, key: string) => numbers(m, key, 1)[0];
const vec = (m: Map<string, string>, key: string) => numbers(m, key, 3) as Vec3;

function lionToEmitter(m: Map<string, string>, matrix: number[], texture: number, seed: number): Emitter | null {
    if (num(m, 'EMITTER_LIFE_INFINITE') !== 1 || num(m, 'DISABLED_FLAG') !== 0 || (m.get('SHAPE') ?? 'SPRITE') !== 'SPRITE')
        return null;
    const rate = num(m, 'EMISSION_RATE_BASE');
    if (rate <= 0)
        return null;
    const colorKeys = [{ time: num(m, 'COLOUR_TIME0'), color: numbers(m, 'COLOUR0', 4).map((c) => c / 255) as [number, number, number, number] }];
    for (let i = 0; i < 3; i++)
        if (num(m, `DO_COLOURSTEP${i}`) === 1)
            colorKeys.push({ time: num(m, `COLOUR_TIME${i + 1}`), color: numbers(m, `COLOUR${i + 1}`, 4).map((c) => c / 255) as [number, number, number, number] });
    return {
        matrix, texture, seed, rate,
        additive: (m.get('BLEND_MODE') ?? 'SRCALPHA') !== 'SRCALPHA',
        lifeBase: num(m, 'LIFE_BASE'), lifeVariance: num(m, 'LIFE_VARIANCE'),
        posBase: vec(m, 'POS_BASE'), posVariance: vec(m, 'POS_VARIANCE'),
        velBase: vec(m, 'VEL_BASE'), velVariance: vec(m, 'VEL_VARIANCE'),
        accBase: vec(m, 'ACC_BASE'), accVariance: vec(m, 'ACC_VARIANCE'),
        sizeBase: vec(m, 'SIZEXYZ_BASE')[0], sizeVariance: vec(m, 'SIZEXYZ_VARIANCE')[0],
        sizeVelBase: vec(m, 'SIZEXYZ_VEL_BASE')[0], sizeVelVariance: vec(m, 'SIZEXYZ_VEL_VARIANCE')[0],
        sizeAccBase: vec(m, 'SIZEXYZ_ACC_BASE')[0], sizeAccVariance: vec(m, 'SIZEXYZ_ACC_VARIANCE')[0],
        rotate: num(m, 'DO_ROTATE') === 1,
        rotBase: vec(m, 'ROTXYZ_BASE')[2], rotVariance: vec(m, 'ROTXYZ_VARIANCE')[2],
        rotVelBase: vec(m, 'ROTXYZ_VEL_BASE')[2], rotVelVariance: vec(m, 'ROTXYZ_VEL_VARIANCE')[2],
        rotAccBase: vec(m, 'ROTXYZ_ACC_BASE')[2], rotAccVariance: vec(m, 'ROTXYZ_ACC_VARIANCE')[2],
        colorKeys,
        fadeIn: num(m, 'ALPHA_FADEIN'), fadeOut: m.has('ALPHA_FADEOUT') ? num(m, 'ALPHA_FADEOUT') : 1,
        scale: m.has('SCALE') ? num(m, 'SCALE') : 1,
    };
}

export function resolveEmitters(records: StrRecord[], placements: Placement[]): Emitter[] {
    const byId = new Map<number, StrRecord>();
    for (const r of records)
        byId.set(r.id, r);
    const textureName = (id: number) => {
        const r = byId.get(id);
        if (r === undefined)
            return '';
        const blob = parseStrFields(r)[0].data.createTypedArray(Uint8Array);
        return String.fromCharCode(...blob.subarray(0x10, 0x14));
    };

    const emitters: Emitter[] = [];
    placements.forEach((placement, index) => {
        if (placement.className !== 'EffectsPackage')
            return;
        const leaf = placement.definition.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '');
        const record = byId.get(CRC32.str(leaf) >>> 0);
        if (record === undefined || record.type !== RecordType.Effect)
            return;
        const fields = parseStrFields(record);
        const ref = (hash: number) => fields.filter((f) => f.type === 6 && f.hash === hash).map((f) => f.data.createDataView().getUint32(0));
        const textures = ref(FieldHash.Texture).map((id) => ({ id, name: textureName(id) }));
        if (textures.length === 0)
            return;
        let k = 0;
        for (const def of ref(FieldHash.Definition)) {
            const r = byId.get(def);
            if (r === undefined)
                continue;
            const text = new TextDecoder('latin1').decode(parseStrFields(r)[0].data.createTypedArray(Uint8Array));
            for (const lion of parseLion(text)) {
                const prefix = (lion.get('TEXTURE') ?? '').slice(0, 4);
                const texture = (textures.find((t) => t.name === prefix) ?? textures[0]).id;
                const emitter = lionToEmitter(lion, placement.matrix, texture, index * 64 + k++);
                if (emitter !== null)
                    emitters.push(emitter);
            }
        }
    });
    return emitters;
}

function random(seed: number, particle: number, channel: number): number {
    let h = (Math.imul(seed, 0x27D4EB2D) ^ Math.imul(particle, 0x165667B1) ^ Math.imul(channel + 1, 0x9E3779B1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
    h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function maxParticles(e: Emitter): number {
    return Math.ceil(e.rate * (e.lifeBase + Math.max(e.lifeVariance, 0))) + 1;
}

export interface ParticleState {
    position: vec3;
    size: number;
    rotation: number;
    color: [number, number, number, number];
}

const scratch = vec3.create();

export function forEachParticle(e: Emitter, time: number, cb: (p: ParticleState) => void): void {
    const maxLife = e.lifeBase + Math.max(e.lifeVariance, 0);
    const last = Math.floor(time * e.rate);
    const first = Math.max(Math.floor((time - maxLife) * e.rate), last - maxParticles(e) + 1);
    const m = e.matrix;
    for (let k = first; k <= last; k++) {
        const age = time - k / e.rate;
        const life = e.lifeBase + random(e.seed, k, 0) * e.lifeVariance;
        if (age < 0 || age > life || life <= 0)
            continue;
        const u = age / life;
        const local = [0, 1, 2].map((c) => {
            const p0 = e.posBase[c] + random(e.seed, k, 1 + c) * e.posVariance[c];
            const v = e.velBase[c] + random(e.seed, k, 4 + c) * e.velVariance[c];
            const a = e.accBase[c] + random(e.seed, k, 7 + c) * e.accVariance[c];
            return (p0 + v * age + 0.5 * a * age * age) * e.scale;
        });
        const x = local[0], y = local[2], z = local[1];
        vec3.set(scratch,
            x * m[0] + y * m[3] + z * m[6] + m[9],
            x * m[1] + y * m[4] + z * m[7] + m[10],
            x * m[2] + y * m[5] + z * m[8] + m[11]);
        const size = Math.max(0, (e.sizeBase + random(e.seed, k, 10) * e.sizeVariance
            + (e.sizeVelBase + random(e.seed, k, 11) * e.sizeVelVariance) * age
            + 0.5 * (e.sizeAccBase + random(e.seed, k, 12) * e.sizeAccVariance) * age * age) * e.scale);
        const rotation = e.rotate ? e.rotBase + random(e.seed, k, 13) * e.rotVariance
            + (e.rotVelBase + random(e.seed, k, 14) * e.rotVelVariance) * age
            + 0.5 * (e.rotAccBase + random(e.seed, k, 15) * e.rotAccVariance) * age * age : 0;

        const keys = e.colorKeys;
        let color = keys[keys.length - 1].color;
        for (let i = 0; i + 1 < keys.length; i++) {
            if (u <= keys[i + 1].time) {
                const span = keys[i + 1].time - keys[i].time;
                const f = span > 0 ? Math.min(Math.max((u - keys[i].time) / span, 0), 1) : 1;
                color = keys[i].color.map((c, j) => c + (keys[i + 1].color[j] - c) * f) as [number, number, number, number];
                break;
            }
        }
        let alpha = color[3];
        if (e.fadeIn > 0 && u < e.fadeIn)
            alpha *= u / e.fadeIn;
        if (e.fadeOut < 1 && u > e.fadeOut)
            alpha *= (1 - u) / (1 - e.fadeOut);

        cb({ position: vec3.fromValues(scratch[0], scratch[2], -scratch[1]), size, rotation, color: [color[0], color[1], color[2], alpha] });
    }
}
