import { mat4, vec3 } from "gl-matrix";
import { MathConstants } from "../MathHelpers.js";
import { Camera, CameraController } from "../Camera.js";
import { White } from "../Color.js";
import { createBufferFromData } from "../gfx/helpers/BufferHelpers.js";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { GfxShaderLibrary } from "../gfx/helpers/GfxShaderLibrary.js";
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from "../gfx/helpers/RenderGraphHelpers.js";
import { makeSolidColorTexture2D } from "../gfx/helpers/TextureHelpers.js";
import { fillMatrix4x4, fillVec4 } from "../gfx/helpers/UniformBufferHelpers.js";
import { GfxBlendFactor, GfxBlendMode, GfxBuffer, GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxTexFilterMode, GfxTexture, GfxVertexBufferFrequency, GfxWrapMode } from "../gfx/platform/GfxPlatform.js";
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
        float t_Pull = min(u_DrawBillboard.x + length(a_TexCoord1), t_Distance * 0.9) / max(t_Distance, 1e-3);
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

void main() {
    vec4 t_Color = texture(SAMPLER_2D(u_TextureBase), v_TexCoord0);
    if (u_DrawBillboard.z > 0.5) {
        gl_FragColor = vec4(t_Color.rgb * v_Color.rgb * 2.0, t_Color.a * v_Color.a * 2.0);
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
    gl_FragColor = t_Color;
}
`;
}

const PICKUP_SPIN_RADIANS_PER_SECOND = 1.4;
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
    private program: GfxProgram;
    private inputLayout: GfxInputLayout;
    private vertexBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private repeatSampler: GfxSampler;
    private clampSampler: GfxSampler;
    private whiteTexture: GfxTexture;
    private textures = new Map<string, GfxTexture>();
    private materials: Material[];
    private translucentOrder: Material[];
    private cameraPosition = vec3.create();
    private time = 0;
    private center: vec3;
    private size: number;

    public textureHolder: FakeTextureHolder;
    public useVertexColors = true;
    public useLightmaps = true;
    public showSkybox = true;
    public showProps = true;
    public showBillboards = true;
    public showBase = true;
    public showCells = true;
    public lightmapScale = 1.5;

    constructor(sceneContext: SceneContext, geometry: GeometryBuilder, textureInputs: Map<string, TextureInputGX>, alphaClasses: Map<string, AlphaClass>, private spawn: number[] | null) {
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
        this.clampSampler = cache.createSampler({
            minFilter: GfxTexFilterMode.Bilinear, magFilter: GfxTexFilterMode.Bilinear, mipFilter: GfxMipFilterMode.Linear,
            wrapS: GfxWrapMode.Clamp, wrapT: GfxWrapMode.Clamp,
        });
        this.whiteTexture = makeSolidColorTexture2D(device, White);

        const used = usedTextureNames(geometry);
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
        viewerInput.camera.setClipPlanes(0.1);
        this.time = viewerInput.time / 1000;
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts([{ numUniformBuffers: 2, numSamplers: 3 }]);
        template.setGfxProgram(this.program);
        template.setVertexInput(this.inputLayout, [{ buffer: this.vertexBuffer, byteOffset: 0 }], { buffer: this.indexBuffer, byteOffset: 0 });
        template.setMegaStateFlags({ cullMode: GfxCullMode.None });

        let offs = 0;
        const scene = template.allocateUniformBufferF32(MOHH2Program.ub_SceneParams, 32);
        offs += fillMatrix4x4(scene, offs, viewerInput.camera.clipFromWorldMatrix);
        offs += fillVec4(scene, offs, this.useVertexColors ? 1 : 0, this.useLightmaps ? 1 : 0, this.lightmapScale, viewerInput.time / 1000);
        mat4.getTranslation(this.cameraPosition, viewerInput.camera.worldMatrix);
        offs += fillVec4(scene, offs, this.cameraPosition[0], this.cameraPosition[1], this.cameraPosition[2], 0);
        const w = viewerInput.camera.worldMatrix;
        offs += fillVec4(scene, offs, w[0], w[1], w[2], 0);
        offs += fillVec4(scene, offs, w[4], w[5], w[6], 0);

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

        renderInstManager.popTemplate();

        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
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
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.renderHelper.prepareToRender();
        builder.execute();
        this.skyList.reset();
        this.opaqueList.reset();
        this.translucentList.reset();
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy();
        device.destroyBuffer(this.vertexBuffer);
        device.destroyBuffer(this.indexBuffer);
        device.destroyTexture(this.whiteTexture);
        for (const t of this.textures.values())
            device.destroyTexture(t);
    }
}
