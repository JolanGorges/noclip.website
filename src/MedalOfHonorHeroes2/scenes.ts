import { GfxDevice } from "../gfx/platform/GfxPlatform.js";
import { SceneContext, SceneDesc, SceneGroup } from "../SceneBase.js";
import { SceneGfx } from "../viewer.js";
import { buildLevelGeometry } from "./geometry.js";
import { classifyTextureAlpha, MOHH2Renderer, usedTextureNames } from "./render.js";
import { loadSkybox, parseEntities, parseLevelFog, parseStrRecords, resolveBillboards, resolvePlacedModels } from "./levelstr.js";
import { parseRez } from "./rez.js";
import { parseLevelTextures, recordTextureName } from "./textures.js";
import { resolveEmitters } from "./particles.js";

const pathBase = `MedalOfHonorHeroes2`;

class MOHH2SceneDesc implements SceneDesc {
    constructor(public id: string, public name: string) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<SceneGfx> {
        const dataFetcher = context.dataFetcher;
        const [rez, str] = await Promise.all([
            dataFetcher.fetchData(`${pathBase}/${this.id}/asyncstr.rez`),
            dataFetcher.fetchData(`${pathBase}/${this.id}/level_a.str`),
        ]);
        const files = parseRez(rez);
        const records = parseStrRecords(str);
        const entities = parseEntities(records);
        const props = resolvePlacedModels(records, entities).map(({ placement, objects }) => ({ objects, matrix: placement.matrix, spin: placement.className === 'WeaponPowerup' }));
        const skybox = loadSkybox(records);
        const billboards = resolveBillboards(records, entities);
        const geometry = buildLevelGeometry(files, skybox, props, billboards);
        // Sewers (map 3): the game lights its smoke, so the mist only shows near the lamps. The lamps
        // are the light glow billboards; positions converted to noclip space.
        const indoor = /^[12]_3/.test(this.id);
        const particleLights = indoor ? billboards.map((b) => [b.matrix[9], b.matrix[11], -b.matrix[10]]) : [];
        const textures = parseLevelTextures(records);
        const emitters = resolveEmitters(records, entities);
        const used = usedTextureNames(geometry);
        for (const e of emitters)
            used.add(recordTextureName(e.texture));
        const alphaClasses = await classifyTextureAlpha(textures, used);
        const player = entities.find((e) => e.className === 'Player');
        return new MOHH2Renderer(context, geometry, textures, alphaClasses, player !== undefined ? player.matrix : null, parseLevelFog(records), emitters, particleLights);
    }
}

const id = `MedalOfHonorHeroes2`;
const name = `Medal of Honor: Heroes 2`;
const sceneDescs = [
    "Campaign",
    new MOHH2SceneDesc(`1_101`, `Port`),
    new MOHH2SceneDesc(`1_201`, `City`),
    new MOHH2SceneDesc(`1_301`, `Sewers`),
    new MOHH2SceneDesc(`1_401`, `Village`),
    new MOHH2SceneDesc(`1_501`, `Monastery`),
    new MOHH2SceneDesc(`1_601`, `Base`),
    new MOHH2SceneDesc(`1_701`, `Beach`),
    new MOHH2SceneDesc(`1_801`, `Bombed City`),
    "Arcade",
    new MOHH2SceneDesc(`1_161`, `Port`),
    new MOHH2SceneDesc(`1_261`, `City`),
    new MOHH2SceneDesc(`1_361`, `Sewers`),
    new MOHH2SceneDesc(`1_461`, `Village`),
    new MOHH2SceneDesc(`1_561`, `Monastery`),
    new MOHH2SceneDesc(`1_661`, `Base`),
    new MOHH2SceneDesc(`1_761`, `Beach`),
    new MOHH2SceneDesc(`1_861`, `Bombed City`),
    "Multiplayer",
    new MOHH2SceneDesc(`2_181`, `Port`),
    new MOHH2SceneDesc(`2_281`, `City`),
    new MOHH2SceneDesc(`2_381`, `Sewers`),
    new MOHH2SceneDesc(`2_481`, `Village`),
    new MOHH2SceneDesc(`2_581`, `Monastery`),
    new MOHH2SceneDesc(`2_681`, `Base`),
];

export const sceneGroup: SceneGroup = { id, name, sceneDescs };
