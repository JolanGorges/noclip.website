import { mat4, vec3 } from "gl-matrix";
import { MathConstants } from "../MathHelpers.js";
import { Camera, CameraController } from "../Camera.js";
import { colorNewFromRGBA, White } from "../Color.js";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers.js";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary.js";
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { makeSolidColorTexture2D } from "../gfx/helpers/TextureHelpers.js";
import { fillMatrix4x4, fillVec4 } from "../gfx/helpers/UniformBufferHelpers.js";
import { GfxBindingLayoutDescriptor, GfxBlendFactor, GfxBlendMode, GfxBuffer, GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxSamplerFormatKind, GfxTexFilterMode, GfxTexture, GfxTextureDimension, GfxVertexBufferFrequency, GfxWrapMode } from "../gfx/platform/GfxPlatform.js";
import { GfxrAttachmentSlot } from "../gfx/render/GfxRenderGraph.js";
import { GfxRenderHelper } from "../gfx/render/GfxRenderHelper.js";
import { GfxRenderInstList } from "../gfx/render/GfxRenderInstManager.js";
import { calcMipChain, decodeTexture, TextureInputGX } from "../gx/gx_texture.js";
import { loadTextureFromMipChain } from "../gx/gx_render.js";
import { DeviceProgram } from "../Program.js";
import { SceneContext } from "../SceneBase.js";
import { FakeTextureHolder } from "../TextureHolder.js";
import * as UI from "../ui.js";
import { SceneGfx, Texture, ViewerRenderInput } from "../viewer.js";
import { DrawKind, DrawRange, GeometryBuilder, VERTEX_FLOATS } from "./geometry.js";
import { LevelFog } from "./levelstr.js";
import { Emitter, forEachParticle, maxParticles } from "./particles.js";
import { recordTextureName } from "./textures.js";

class MOHH2Program extends DeviceProgram {
    public static a_Position = 0;
    public static a_Color = 1;
    public static a_TexCoord0 = 2;
    public static a_TexCoord1 = 3;

    public static ub_SceneParams = 0;
    public static ub_DrawParams = 1;

    public static Common = `
${GfxShaderLibrary.MatrixLibrary}

layout(std140) uniform ub_SceneParams {
    Mat4x4 u_ClipFromWorld;
    vec4 u_SceneMisc;
    vec4 u_CameraPos;
    vec4 u_CameraRight;
    vec4 u_CameraUp;
    vec4 u_Fog;
    vec4 u_FogColor;
};

layout(std140) uniform ub_DrawParams {
    vec4 u_DrawMisc;
    vec4 u_DrawAnim;
    vec4 u_DrawUV;
    vec4 u_DrawBillboardFade;
    vec4 u_DrawBillboard;
};

layout(binding = 0) uniform sampler2D u_TextureBase;
layout(binding = 1) uniform sampler2D u_TextureLight;
layout(binding = 2) uniform sampler2D u_TextureMask;
`;

    public override vert = `
${MOHH2Program.Common}

layout(location = ${MOHH2Program.a_Position}) in vec3 a_Position;
layout(location = ${MOHH2Program.a_Color}) in vec4 a_Color;
layout(location = ${MOHH2Program.a_TexCoord0}) in vec2 a_TexCoord0;
layout(location = ${MOHH2Program.a_TexCoord1}) in vec2 a_TexCoord1;

out vec4 v_Color;
out vec2 v_TexCoord0;
out vec2 v_TexCoord1;
out vec3 v_WorldPosition;

void main() {
    vec3 t_Position = a_Position;
    float t_Fade = 1.0;
    if (u_DrawBillboard.z > 0.5) {
        vec3 t_ToCamera = u_CameraPos.xyz - a_Position;
        float t_Distance = length(t_ToCamera);
        vec3 t_Right = u_CameraRight.xyz, t_Up = u_CameraUp.xyz;
        if (u_DrawBillboard.y > 1.5) {
            t_Up = vec3(0.0, 1.0, 0.0);
            t_Right = normalize(cross(t_Up, t_ToCamera));
        }
        float t_Pull = min(u_DrawBillboard.x + length(a_TexCoord1) * (1.0 - u_DrawBillboard.w), t_Distance * 0.9) / max(t_Distance, 1e-3);
        t_Position = a_Position + t_ToCamera * t_Pull + (t_Right * a_TexCoord1.x + t_Up * a_TexCoord1.y) * (1.0 - t_Pull);
        t_Fade = clamp((t_Distance - u_DrawBillboardFade.x) / max(u_DrawBillboardFade.y - u_DrawBillboardFade.x, 1e-3), 0.0, 1.0);
        t_Fade *= clamp((u_DrawBillboardFade.w - t_Distance) / max(u_DrawBillboardFade.w - u_DrawBillboardFade.z, 1e-3), 0.0, 1.0);
    }
    if (u_DrawMisc.w > 0.5)
        t_Position += u_CameraPos.xyz;
    if (u_DrawAnim.w > 0.0) {
        float t_Angle = u_SceneMisc.w * u_DrawAnim.w;
        vec2 t_Offset = t_Position.xz - u_DrawAnim.xz;
        float c = cos(t_Angle), s = sin(t_Angle);
        t_Position.xz = u_DrawAnim.xz + vec2(c * t_Offset.x - s * t_Offset.y, s * t_Offset.x + c * t_Offset.y);
    }
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(t_Position, 1.0);
    v_WorldPosition = t_Position;
    v_Color = vec4(a_Color.rgb, a_Color.a * t_Fade);
    v_TexCoord0 = a_TexCoord0 + u_DrawUV.xy;
    v_TexCoord1 = a_TexCoord1;
}
`;

    public override frag = `
${MOHH2Program.Common}

in vec4 v_Color;
in vec2 v_TexCoord0;
in vec2 v_TexCoord1;
in vec3 v_WorldPosition;

float FogAmount() {
    if (u_Fog.z < 0.5 || (u_DrawMisc.w > 0.5 && u_Fog.w < 0.5))
        return 0.0;
    float t_Distance = distance(v_WorldPosition, u_CameraPos.xyz);
    return clamp((t_Distance - u_Fog.x) / max(u_Fog.y - u_Fog.x, 1e-3), 0.0, 1.0);
}

void main() {
    vec4 t_Color = texture(SAMPLER_2D(u_TextureBase), v_TexCoord0);
    if (u_DrawBillboard.z > 0.5) {
        float t_Soft = 1.0;
        if (u_DrawUV.z > 0.0) {
            // Soft particles: fade out where the sprite gets close to the surface behind it, so big
            // puffs do not cut straight lines into walls. Depth is reversed with an infinite far
            // plane, so distance = near / depth.
            vec2 t_Size = vec2(textureSize(TEXTURE(u_TextureMask), 0));
            float t_SceneDepth = texture(SAMPLER_2D(u_TextureMask), gl_FragCoord.xy / t_Size).r;
            float t_SceneDistance = u_DrawUV.w / max(t_SceneDepth, 1e-7);
            float t_FragDistance = u_DrawUV.w / max(gl_FragCoord.z, 1e-7);
            t_Soft = clamp((t_SceneDistance - t_FragDistance) / u_DrawUV.z, 0.0, 1.0);
        }
        gl_FragColor = vec4(t_Color.rgb * v_Color.rgb * 2.0, t_Color.a * v_Color.a * 2.0 * (1.0 - FogAmount()) * t_Soft);
        return;
    }
    if (u_DrawMisc.z > 0.5)
        t_Color.a = texture(SAMPLER_2D(u_TextureMask), v_TexCoord0).a;
    if (u_DrawMisc.w > 0.5)
        t_Color.a *= v_Color.a;
    else if (u_SceneMisc.x > 0.5)
        t_Color *= vec4(v_Color.rgb * 2.0, v_Color.a);
    if (u_DrawMisc.x > 0.5 && u_SceneMisc.y > 0.5)
        t_Color.rgb *= texture(SAMPLER_2D(u_TextureLight), v_TexCoord1).rgb * u_SceneMisc.z;
    if (t_Color.a < u_DrawMisc.y)
        discard;
    t_Color.rgb = mix(t_Color.rgb, u_FogColor.rgb, FogAmount());
    gl_FragColor = t_Color;
}
`;
}

const PICKUP_SPIN_RADIANS_PER_SECOND = 1.4;
const PARTICLE_SOFT_DISTANCE = 1.5;
const NEAR_PLANE = 0.1;
const SCENE_DEPTH = 'scene-depth';
const particleBindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 2, numSamplers: 3, samplerEntries: [
    { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float },
    { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.Float },
    { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.UnfilterableFloat },
] }];
const PLAYER_EYE_HEIGHT = 1.7;
const GAME_FOV_Y = 46.83 * MathConstants.DEG_TO_RAD;

export const enum AlphaClass { Opaque, Binary, Graded }

export async function classifyTextureAlpha(inputs: Map<string, TextureInputGX>, names: Iterable<string>): Promise<Map<string, AlphaClass>> {
    const classes = new Map<string, AlphaClass>();
    for (const name of names) {
        const input = inputs.get(name);
        if (input === undefined)
            continue;
        const decoded = (await decodeTexture({ ...input, mipCount: 1 })).pixels;
        const pixels = new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.byteLength);
        let transparent = 0, partial = 0;
        for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] < 0xFF) transparent++;
            if (pixels[i] > 0x08 && pixels[i] < 0xF7) partial++;
        }
        const count = pixels.length / 4;
        classes.set(name, transparent === 0 ? AlphaClass.Opaque : partial < count * 0.03 ? AlphaClass.Binary : AlphaClass.Graded);
    }
    return classes;
}

export function usedTextureNames(geometry: GeometryBuilder): Set<string> {
    const used = new Set<string>();
    for (const d of geometry.draws)
        for (const name of [d.baseTexture, d.maskTexture, d.lightTexture])
            if (name !== null)
                used.add(name);
    return used;
}

interface Material {
    draw: DrawRange;
    kind: DrawKind;
}

export class MOHH2Renderer implements SceneGfx {
    private renderHelper: GfxRenderHelper;
    private skyList = new GfxRenderInstList(null);
    private opaqueList = new GfxRenderInstList();
    private translucentList = new GfxRenderInstList(null);
    private particleList = new GfxRenderInstList(null);
    private program: GfxProgram;
    private inputLayout: GfxInputLayout;
    private vertexBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private repeatSampler: GfxSampler;
    private clampSampler: GfxSampler;
    private depthSampler: GfxSampler;
    private whiteTexture: GfxTexture;
    private textures = new Map<string, GfxTexture>();
    private materials: Material[];
    private translucentOrder: Material[];
    private cameraPosition = vec3.create();
    private time = 0;
    private particleRanges: { firstQuad: number, capacity: number }[] = [];
    private particleVertices: Float32Array | null = null;
    private particleVertexBuffer: GfxBuffer | null = null;
    private particleIndexBuffer: GfxBuffer | null = null;
    private center: vec3;
    private size: number;

    public textureHolder: FakeTextureHolder;
    public useVertexColors = true;
    public useLightmaps = true;
    public showSkybox = true;
    public showProps = true;
    public showBillboards = true;
    public useFog = true;
    public showParticles = true;
    public showBase = true;
    public showCells = true;
    public lightmapScale = 1.5;

    constructor(sceneContext: SceneContext, geometry: GeometryBuilder, textureInputs: Map<string, TextureInputGX>, alphaClasses: Map<string, AlphaClass>, private spawn: number[] | null, private fog: LevelFog | null, private emitters: Emitter[] = []) {
        const device = sceneContext.device;
        this.renderHelper = new GfxRenderHelper(device, sceneContext);
        const cache = this.renderHelper.renderCache;

        this.program = cache.createProgram(new MOHH2Program());
        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, geometry.vertexData.buffer);
        this.indexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, geometry.indexData.buffer);
        this.inputLayout = cache.createInputLayout({
            vertexAttributeDescriptors: [
                { location: MOHH2Program.a_Position, format: GfxFormat.F32_RGB, bufferByteOffset: 0, bufferIndex: 0 },
                { location: MOHH2Program.a_Color, format: GfxFormat.F32_RGBA, bufferByteOffset: 3 * 4, bufferIndex: 0 },
                { location: MOHH2Program.a_TexCoord0, format: GfxFormat.F32_RG, bufferByteOffset: 7 * 4, bufferIndex: 0 },
                { location: MOHH2Program.a_TexCoord1, format: GfxFormat.F32_RG, bufferByteOffset: 9 * 4, bufferIndex: 0 },
            ],
            vertexBufferDescriptors: [{ byteStride: VERTEX_FLOATS * 4, frequency: GfxVertexBufferFrequency.PerVertex }],
            indexBufferFormat: GfxFormat.U32_R,
        });

        this.repeatSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear, magFilter: GfxTexFilterMode.Bilinear, mipFilter: GfxMipFilterMode.Linear,
            wrapS: GfxWrapMode.Repeat, wrapT: GfxWrapMode.Repeat, maxAnisotropy: 16,
        });
        this.depthSampler = cache.createSampler({
            wrapS: GfxWrapMode.Clamp, wrapT: GfxWrapMode.Clamp,
            minFilter: GfxTexFilterMode.Point, magFilter: GfxTexFilterMode.Point, mipFilter: GfxMipFilterMode.Nearest,
            minLOD: 0, maxLOD: 0,
        });
        this.clampSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear, magFilter: GfxTexFilterMode.Bilinear, mipFilter: GfxMipFilterMode.Linear,
            wrapS: GfxWrapMode.Clamp, wrapT: GfxWrapMode.Clamp,
        });
        this.whiteTexture = makeSolidColorTexture2D(device, White);

        const used = usedTextureNames(geometry);
        for (const e of emitters)
            used.add(recordTextureName(e.texture));
        const viewerTextures: Texture[] = [];
        for (const name of [...used].sort()) {
            const input = textureInputs.get(name);
            if (input === undefined)
                continue;
            const loaded = loadTextureFromMipChain(device, calcMipChain(input, input.mipCount));
            this.textures.set(name, loaded.gfxTexture);
            viewerTextures.push(loaded.viewerTexture);
        }
        this.textureHolder = new FakeTextureHolder(viewerTextures);

        this.createParticleBuffers(device);
        this.materials = geometry.draws.map((draw) => {
            const alphaTexture = draw.maskTexture ?? draw.baseTexture;
            const alpha = alphaTexture !== null ? alphaClasses.get(alphaTexture) ?? AlphaClass.Opaque : AlphaClass.Opaque;
            let kind = DrawKind.Opaque;
            if (draw.kind === DrawKind.Translucent || alpha === AlphaClass.Graded || draw.vertexAlpha)
                kind = DrawKind.Translucent;
            else if (draw.kind === DrawKind.AlphaTest || alpha === AlphaClass.Binary)
                kind = DrawKind.AlphaTest;
            return { draw, kind };
        });
        this.translucentOrder = this.materials.filter((m) => m.kind === DrawKind.Translucent && !m.draw.sky);
        this.center = vec3.lerp(vec3.create(), geometry.min, geometry.max, 0.5);
        this.size = vec3.distance(geometry.min, geometry.max);
    }

    public adjustCameraController(c: CameraController): void {
        c.setSceneMoveSpeedMult(0.01);
    }

    public getDefaultWorldMatrix(dst: mat4): void {
        if (this.spawn !== null) {
            const m = this.spawn;
            const eye = vec3.fromValues(m[9], m[11] + PLAYER_EYE_HEIGHT, -m[10]);
            const target = vec3.fromValues(eye[0] + m[3], eye[1] + m[5], eye[2] - m[4]);
            mat4.targetTo(dst, eye, target, [0, 1, 0]);
            return;
        }
        const eye = vec3.fromValues(this.center[0], this.center[1] + this.size * 0.25, this.center[2] + this.size * 0.35);
        mat4.targetTo(dst, eye, this.center, [0, 1, 0]);
    }

    public createPanels(): UI.Panel[] {
        const panel = new UI.Panel();
        panel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        panel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');

        const vertexColors = new UI.Checkbox('Vertex Colors', this.useVertexColors);
        vertexColors.onchanged = () => { this.useVertexColors = vertexColors.checked; };
        panel.contents.appendChild(vertexColors.elem);

        const lightmaps = new UI.Checkbox('Lightmaps', this.useLightmaps);
        lightmaps.onchanged = () => { this.useLightmaps = lightmaps.checked; };
        panel.contents.appendChild(lightmaps.elem);

        const skybox = new UI.Checkbox('Skybox', this.showSkybox);
        skybox.onchanged = () => { this.showSkybox = skybox.checked; };
        panel.contents.appendChild(skybox.elem);

        const baseLayer = new UI.Checkbox('Base Compartment', this.showBase);
        baseLayer.onchanged = () => { this.showBase = baseLayer.checked; };
        panel.contents.appendChild(baseLayer.elem);

        const cellLayer = new UI.Checkbox('Streamed Cells', this.showCells);
        cellLayer.onchanged = () => { this.showCells = cellLayer.checked; };
        panel.contents.appendChild(cellLayer.elem);

        const particles = new UI.Checkbox('Particles', this.showParticles);
        particles.onchanged = () => { this.showParticles = particles.checked; };
        panel.contents.appendChild(particles.elem);

        const fogToggle = new UI.Checkbox('Fog', this.useFog);
        fogToggle.onchanged = () => { this.useFog = fogToggle.checked; };
        panel.contents.appendChild(fogToggle.elem);

        const billboards = new UI.Checkbox('Light Glows', this.showBillboards);
        billboards.onchanged = () => { this.showBillboards = billboards.checked; };
        panel.contents.appendChild(billboards.elem);

        const props = new UI.Checkbox('Placed Objects', this.showProps);
        props.onchanged = () => { this.showProps = props.checked; };
        panel.contents.appendChild(props.elem);

        const lightmapScale = new UI.Slider('Lightmap Scale', this.lightmapScale, 0.5, 4.0);
        lightmapScale.onvalue = () => { this.lightmapScale = lightmapScale.getValue(); };
        panel.contents.appendChild(lightmapScale.elem);

        return [panel];
    }

    private createParticleBuffers(device: GfxDevice): void {
        let quads = 0;
        for (const e of this.emitters) {
            this.particleRanges.push({ firstQuad: quads, capacity: maxParticles(e) });
            quads += maxParticles(e);
        }
        if (quads === 0)
            return;
        this.particleVertices = new Float32Array(quads * 4 * VERTEX_FLOATS);
        this.particleVertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Dynamic, this.particleVertices.buffer);
        const indices = new Uint32Array(quads * 6);
        for (let q = 0; q < quads; q++)
            indices.set([4 * q, 4 * q + 1, 4 * q + 2, 4 * q, 4 * q + 2, 4 * q + 3], 6 * q);
        this.particleIndexBuffer = createBufferFromData(device, GfxBufferUsage.Index, GfxBufferFrequencyHint.Static, indices.buffer);
    }

    private submitParticles(device: GfxDevice): void {
        if (this.particleVertices === null || this.particleVertexBuffer === null || this.particleIndexBuffer === null || !this.showParticles)
            return;
        const v = this.particleVertices;
        const corners = [[-1, -1, 0, 1], [1, -1, 1, 1], [1, 1, 1, 0], [-1, 1, 0, 0]];
        const counts: number[] = [];
        this.emitters.forEach((e, i) => {
            const range = this.particleRanges[i];
            let n = 0;
            forEachParticle(e, this.time, (p) => {
                if (n >= range.capacity)
                    return;
                const c = Math.cos(p.rotation), s = Math.sin(p.rotation), h = p.size;
                let o = (range.firstQuad + n) * 4 * VERTEX_FLOATS;
                for (const [cx, cy, u, w] of corners) {
                    v.set([p.position[0], p.position[1], p.position[2], p.color[0] / 2, p.color[1] / 2, p.color[2] / 2, p.color[3] / 2, u, w,
                        (cx * c - cy * s) * h, (cx * s + cy * c) * h], o);
                    o += VERTEX_FLOATS;
                }
                n++;
            });
            counts.push(n);
        });
        device.uploadBufferData(this.particleVertexBuffer, 0, new Uint8Array(v.buffer));

        this.emitters.forEach((e, i) => {
            if (counts[i] === 0)
                return;
            const texture = this.textures.get(recordTextureName(e.texture));
            if (texture === undefined)
                return;
            const renderInst = this.renderHelper.renderInstManager.newRenderInst();
            renderInst.setVertexInput(this.inputLayout, [{ buffer: this.particleVertexBuffer!, byteOffset: 0 }], { buffer: this.particleIndexBuffer!, byteOffset: 0 });
            renderInst.setBindingLayouts(particleBindingLayouts);
            renderInst.setSamplerBindings(0, [
                { gfxTexture: texture, gfxSampler: this.clampSampler },
                { gfxTexture: this.whiteTexture, gfxSampler: this.clampSampler },
                { gfxTexture: null, gfxSampler: this.depthSampler, lateBinding: SCENE_DEPTH },
            ]);
            const params = renderInst.allocateUniformBufferF32(MOHH2Program.ub_DrawParams, 20);
            fillVec4(params, 0, 0, 1 / 255, 0, 0);
            fillVec4(params, 4, 0, 0, 0, 0);
            fillVec4(params, 8, 0, 0, PARTICLE_SOFT_DISTANCE, NEAR_PLANE);
            fillVec4(params, 12, 0, 0, 1e6, 1e6 + 1);
            fillVec4(params, 16, 0, 0, 1, 1);
            renderInst.setDrawCount(counts[i] * 6, this.particleRanges[i].firstQuad * 6);
            const megaState = renderInst.getMegaStateFlags();
            megaState.depthWrite = false;
            setAttachmentStateSimple(megaState, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.SrcAlpha, blendDstFactor: e.additive ? GfxBlendFactor.One : GfxBlendFactor.OneMinusSrcAlpha });
            this.particleList.submitRenderInst(renderInst);
        });
    }

    private isVisible(d: DrawRange): boolean {
        if (d.sky)
            return this.showSkybox;
        if (d.prop)
            return this.showProps;
        if (d.billboard !== null)
            return this.showBillboards;
        return d.cell ? this.showCells : this.showBase;
    }

    private newDrawInst(m: Material, sky: boolean) {
        const d = m.draw;
        const renderInst = this.renderHelper.renderInstManager.newRenderInst();
        const texture = (name: string | null) => (name !== null && this.textures.get(name)) || this.whiteTexture;
        renderInst.setSamplerBindings(0, [
            { gfxTexture: texture(d.baseTexture), gfxSampler: this.repeatSampler },
            { gfxTexture: texture(d.lightTexture), gfxSampler: this.clampSampler },
            { gfxTexture: texture(d.maskTexture), gfxSampler: this.repeatSampler },
        ]);
        const alphaRef = m.kind === DrawKind.AlphaTest ? 0.5 : m.kind === DrawKind.Translucent ? 1 / 255 : 0;
        const params = renderInst.allocateUniformBufferF32(MOHH2Program.ub_DrawParams, 20);
        fillVec4(params, 0, d.lightTexture !== null ? 1 : 0, alphaRef, d.maskTexture !== null ? 1 : 0, sky ? 1 : 0);
        const pivot = d.spinPivot;
        fillVec4(params, 4, pivot !== null ? pivot[0] : 0, pivot !== null ? pivot[1] : 0, pivot !== null ? pivot[2] : 0, pivot !== null ? PICKUP_SPIN_RADIANS_PER_SECOND : 0);
        const scroll = d.scrollUV;
        fillVec4(params, 8, scroll !== null ? (this.time * scroll[0]) % 1 : 0, scroll !== null ? (this.time * scroll[1]) % 1 : 0, 0, 0);
        const b = d.billboard;
        fillVec4(params, 12, b !== null ? b.nearClip : 0, b !== null ? b.nearFade : 0, b !== null ? b.farFade : 0, b !== null ? b.farClip : 0);
        fillVec4(params, 16, b !== null ? b.zBias : 0, b !== null ? b.axisType : 0, b !== null ? 1 : 0, 0);
        renderInst.setDrawCount(d.indexCount, d.indexOffset);
        const megaState = renderInst.getMegaStateFlags();
        if (d.billboard !== null) {
            megaState.depthWrite = false;
            setAttachmentStateSimple(megaState, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.SrcAlpha, blendDstFactor: GfxBlendFactor.One });
        } else if (m.kind === DrawKind.Translucent) {
            megaState.depthWrite = false;
            megaState.polygonOffset = !sky;
            setAttachmentStateSimple(megaState, { blendMode: GfxBlendMode.Add, blendSrcFactor: GfxBlendFactor.SrcAlpha, blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha });
        }
        return renderInst;
    }

    public render(device: GfxDevice, viewerInput: ViewerRenderInput): void {
        const renderInstManager = this.renderHelper.renderInstManager;
        if (Math.abs(viewerInput.camera.fovY - Camera.DefaultFovY) < 0.01)
            viewerInput.camera.fovY = GAME_FOV_Y;
        viewerInput.camera.setClipPlanes(NEAR_PLANE);
        this.time = viewerInput.time / 1000;
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts([{ numUniformBuffers: 2, numSamplers: 3 }]);
        template.setGfxProgram(this.program);
        template.setVertexInput(this.inputLayout, [{ buffer: this.vertexBuffer, byteOffset: 0 }], { buffer: this.indexBuffer, byteOffset: 0 });
        template.setMegaStateFlags({ cullMode: GfxCullMode.None });

        let offs = 0;
        const scene = template.allocateUniformBufferF32(MOHH2Program.ub_SceneParams, 40);
        offs += fillMatrix4x4(scene, offs, viewerInput.camera.clipFromWorldMatrix);
        offs += fillVec4(scene, offs, this.useVertexColors ? 1 : 0, this.useLightmaps ? 1 : 0, this.lightmapScale, viewerInput.time / 1000);
        mat4.getTranslation(this.cameraPosition, viewerInput.camera.worldMatrix);
        offs += fillVec4(scene, offs, this.cameraPosition[0], this.cameraPosition[1], this.cameraPosition[2], 0);
        const w = viewerInput.camera.worldMatrix;
        offs += fillVec4(scene, offs, w[0], w[1], w[2], 0);
        offs += fillVec4(scene, offs, w[4], w[5], w[6], 0);
        const fog = this.fog;
        offs += fillVec4(scene, offs, fog?.start ?? 0, fog?.end ?? 1, fog !== null && fog.enabled && this.useFog ? 1 : 0, fog?.onSky ? 1 : 0);
        offs += fillVec4(scene, offs, fog?.color[0] ?? 0, fog?.color[1] ?? 0, fog?.color[2] ?? 0, 1);

        for (const m of this.materials) {
            if (!this.isVisible(m.draw))
                continue;
            if (m.draw.sky)
                this.skyList.submitRenderInst(this.newDrawInst(m, true));
            else if (m.kind !== DrawKind.Translucent)
                this.opaqueList.submitRenderInst(this.newDrawInst(m, false));
        }

        mat4.getTranslation(this.cameraPosition, viewerInput.camera.worldMatrix);
        const distances = new Map<Material, number>();
        for (const m of this.translucentOrder)
            distances.set(m, vec3.squaredDistance(this.cameraPosition, m.draw.center));
        this.translucentOrder.sort((a, b) => distances.get(b)! - distances.get(a)!);
        for (const m of this.translucentOrder)
            if (this.isVisible(m.draw))
                this.translucentList.submitRenderInst(this.newDrawInst(m, false));

        this.submitParticles(device);
        renderInstManager.popTemplate();

        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const clearColor = colorNewFromRGBA(0.02, 0.02, 0.02, 1);
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, makeAttachmentClearDescriptor(clearColor));
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);
        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        const skyDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Sky Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Sky');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, skyDepthTargetID);
            pass.exec((passRenderer) => {
                this.skyList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.opaqueList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                this.translucentList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        builder.pushPass((pass) => {
            pass.setDebugName('Particles');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            const depthResolveID = builder.resolveRenderTarget(mainDepthTargetID);
            pass.attachResolveTexture(depthResolveID);
            pass.exec((passRenderer, scope) => {
                this.particleList.resolveLateSamplerBinding(SCENE_DEPTH, { gfxTexture: scope.getResolveTextureForID(depthResolveID), gfxSampler: this.depthSampler });
                this.particleList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.renderHelper.prepareToRender();
        builder.execute();
        this.skyList.reset();
        this.opaqueList.reset();
        this.translucentList.reset();
        this.particleList.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        if (this.particleVertexBuffer !== null)
            device.destroyBuffer(this.particleVertexBuffer);
        if (this.particleIndexBuffer !== null)
            device.destroyBuffer(this.particleIndexBuffer);
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyTexture(this.whiteTexture);
        for (const t of this.textures.values())
            device.destroyTexture(t);
    }
}
