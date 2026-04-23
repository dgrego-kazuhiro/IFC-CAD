import { mat4 } from "gl-matrix";

/**
 * 2D sketch overlay renderer that draws lines, filled world-axis-aligned
 * rectangles, and SDF markers (circle/diamond) on top of the 3D scene using
 * WebGPU. Aims for SVG-quality lines via DPR-aware backing store, MSAA 4x,
 * and analytical per-pixel AA with round caps.
 */

export interface SketchLine {
    ax: number; az: number;
    bx: number; bz: number;
    color: [number, number, number, number];
    width: number;       // CSS pixels
    dash?: number;       // dash period in CSS pixels; 0 = solid
    dashRatio?: number;  // 0..1 fraction filled; default 0.6
}

/**
 * A convex quadrilateral in world XZ.
 * Points must be supplied in order (CW or CCW). Triangulated as (0,1,2) + (0,2,3).
 */
export interface SketchQuad {
    p0: [number, number];
    p1: [number, number];
    p2: [number, number];
    p3: [number, number];
    color: [number, number, number, number];
}

export type MarkerShape = "circle" | "diamond" | "square";

export interface SketchMarker {
    wx: number; wz: number;
    radius: number;       // CSS pixels
    shape: MarkerShape;
    fill: [number, number, number, number];
    stroke: [number, number, number, number];
    strokeWidth: number;  // CSS pixels
}

const MSAA = 4;

const LINE_FLOATS = 12;   // vec4 ab + vec4 color + vec4 params
const QUAD_FLOATS = 12;   // vec4 p01 + vec4 p23 + vec4 color
const MARKER_FLOATS = 16; // vec4 pos + vec4 fill + vec4 stroke + vec4 extras

export class SketchOverlayRenderer {
    private canvas: HTMLCanvasElement;
    private device: GPUDevice | null = null;
    private context: GPUCanvasContext | null = null;
    private format: GPUTextureFormat = "bgra8unorm";

    private msaaTex: GPUTexture | null = null;
    private msaaView: GPUTextureView | null = null;

    private uniformBuffer: GPUBuffer | null = null;
    private uniformBindGroup: GPUBindGroup | null = null;

    private linePipeline: GPURenderPipeline | null = null;
    private quadPipeline: GPURenderPipeline | null = null;
    private markerPipeline: GPURenderPipeline | null = null;

    private lineStorage: GPUBuffer | null = null;
    private lineStorageCap = 0;
    private lineBindGroup: GPUBindGroup | null = null;

    private quadStorage: GPUBuffer | null = null;
    private quadStorageCap = 0;
    private quadBindGroup: GPUBindGroup | null = null;

    private markerStorage: GPUBuffer | null = null;
    private markerStorageCap = 0;
    private markerBindGroup: GPUBindGroup | null = null;

    private lineBGL!: GPUBindGroupLayout;
    private quadBGL!: GPUBindGroupLayout;
    private markerBGL!: GPUBindGroupLayout;

    private widthPx = 1;   // physical
    private heightPx = 1;  // physical
    private dpr = 1;
    private initialized = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    async init(): Promise<boolean> {
        if (!navigator.gpu) return false;
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) return false;
        this.device = await adapter.requestDevice();
        const ctx = this.canvas.getContext("webgpu");
        if (!ctx) return false;
        this.context = ctx;
        this.format = navigator.gpu.getPreferredCanvasFormat();
        ctx.configure({ device: this.device, format: this.format, alphaMode: "premultiplied" });
        this.buildPipelines();
        this.initialized = true;
        return true;
    }

    destroy() {
        this.msaaTex?.destroy();
        this.lineStorage?.destroy();
        this.quadStorage?.destroy();
        this.markerStorage?.destroy();
        this.uniformBuffer?.destroy();
        this.initialized = false;
    }

    resize(cssWidth: number, cssHeight: number, dpr: number) {
        if (!this.device) return;
        this.dpr = dpr;
        const w = Math.max(1, Math.floor(cssWidth * dpr));
        const h = Math.max(1, Math.floor(cssHeight * dpr));
        if (w === this.widthPx && h === this.heightPx) return;
        this.widthPx = w;
        this.heightPx = h;
        this.canvas.width = w;
        this.canvas.height = h;

        this.msaaTex?.destroy();
        this.msaaTex = this.device.createTexture({
            size: [w, h],
            format: this.format,
            sampleCount: MSAA,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.msaaView = this.msaaTex.createView();
    }

    private buildPipelines() {
        const device = this.device!;

        this.uniformBuffer = device.createBuffer({
            size: 96, // mat4 (64) + vec4 viewport (16) + padding (16)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const camBGL = device.createBindGroupLayout({
            entries: [{
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" },
            }],
        });
        this.uniformBindGroup = device.createBindGroup({
            layout: camBGL,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
        });

        this.lineBGL = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }],
        });
        this.quadBGL = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }],
        });
        this.markerBGL = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }],
        });

        const blend: GPUBlendState = {
            color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        };
        const multisample: GPUMultisampleState = { count: MSAA };
        const targets: GPUColorTargetState[] = [{ format: this.format, blend }];

        // ─── Line pipeline ───
        const lineCode = `
struct Uniforms {
    vp: mat4x4f,
    viewport: vec4f, // width, height, dpr, _
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct Line {
    ab: vec4f,
    color: vec4f,
    params: vec4f, // width(px), dash(px), dashRatio, _
};
@group(1) @binding(0) var<storage, read> lines: array<Line>;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
    @location(1) seg: vec2f,    // along px, perp px
    @location(2) params: vec4f, // length, halfWidth, dash, dashRatio
};

@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VSOut {
    let line = lines[iid];
    let aWorld = vec4f(line.ab.x, 0.0, line.ab.y, 1.0);
    let bWorld = vec4f(line.ab.z, 0.0, line.ab.w, 1.0);
    let aClip = u.vp * aWorld;
    let bClip = u.vp * bWorld;

    let aNdc = aClip.xyz / aClip.w;
    let bNdc = bClip.xyz / bClip.w;

    let halfVP = u.viewport.xy * 0.5;
    let aPix = vec2f(aNdc.x * halfVP.x, -aNdc.y * halfVP.y);
    let bPix = vec2f(bNdc.x * halfVP.x, -bNdc.y * halfVP.y);

    var delta = bPix - aPix;
    let segLen = max(length(delta), 0.0001);
    let dir = delta / segLen;
    let normal = vec2f(-dir.y, dir.x);

    let halfW = line.params.x * 0.5 * u.viewport.z + 1.5;
    let capPad = halfW;

    var along: f32 = 0.0;
    var perp:  f32 = 0.0;
    var useB:  bool = false;

    switch (vid) {
        case 0u: { along = -capPad;         perp = -halfW; useB = false; }
        case 1u: { along = -capPad;         perp =  halfW; useB = false; }
        case 2u: { along =  segLen + capPad; perp = -halfW; useB = true;  }
        case 3u: { along =  segLen + capPad; perp = -halfW; useB = true;  }
        case 4u: { along = -capPad;         perp =  halfW; useB = false; }
        default: { along =  segLen + capPad; perp =  halfW; useB = true;  }
    }

    let pix = aPix + dir * along + normal * perp;
    let srcClip = select(aClip, bClip, useB);
    let ndc2 = vec2f(pix.x / halfVP.x, -pix.y / halfVP.y);

    var out: VSOut;
    out.pos = vec4f(ndc2 * srcClip.w, srcClip.z, srcClip.w);
    out.color = line.color;
    out.seg = vec2f(along, perp);
    out.params = vec4f(segLen, line.params.x * 0.5 * u.viewport.z, line.params.y * u.viewport.z, line.params.z);
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let along = in.seg.x;
    let perp  = in.seg.y;
    let L     = in.params.x;
    let hw    = in.params.y;
    let dashPx = in.params.z;
    let dashR  = in.params.w;

    let beforeA = max(-along, 0.0);
    let afterB  = max(along - L, 0.0);
    let d = length(vec2f(beforeA + afterB, perp));
    let sd = d - hw;
    let aa = 1.0 - smoothstep(-0.5, 0.5, sd);
    if (aa < 0.0005) { discard; }

    var dashAlpha: f32 = 1.0;
    if (dashPx > 0.0) {
        let t = clamp(along, 0.0, L) / dashPx;
        let phase = fract(t);
        dashAlpha = 1.0 - smoothstep(dashR - 0.05, dashR + 0.05, phase);
    }

    let a = in.color.a * aa * dashAlpha;
    return vec4f(in.color.rgb, a);
}
`;

        const lineModule = device.createShaderModule({ code: lineCode });
        this.linePipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [camBGL, this.lineBGL] }),
            vertex: { module: lineModule, entryPoint: "vs" },
            fragment: { module: lineModule, entryPoint: "fs", targets },
            primitive: { topology: "triangle-list" },
            multisample,
        });

        // ─── Quad pipeline (filled world-axis-aligned rects) ───
        const quadCode = `
struct Uniforms { vp: mat4x4f, viewport: vec4f };
@group(0) @binding(0) var<uniform> u: Uniforms;

struct Quad { p01: vec4f, p23: vec4f, color: vec4f };
@group(1) @binding(0) var<storage, read> quads: array<Quad>;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) color: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VSOut {
    let q = quads[iid];
    // Triangulate as (0,1,2) + (0,2,3)
    var p: vec2f;
    switch (vid) {
        case 0u: { p = q.p01.xy; }
        case 1u: { p = q.p01.zw; }
        case 2u: { p = q.p23.xy; }
        case 3u: { p = q.p01.xy; }
        case 4u: { p = q.p23.xy; }
        default: { p = q.p23.zw; }
    }
    var out: VSOut;
    out.pos = u.vp * vec4f(p.x, 0.0, p.y, 1.0);
    out.color = q.color;
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    return in.color;
}
`;

        const quadModule = device.createShaderModule({ code: quadCode });
        this.quadPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [camBGL, this.quadBGL] }),
            vertex: { module: quadModule, entryPoint: "vs" },
            fragment: { module: quadModule, entryPoint: "fs", targets },
            primitive: { topology: "triangle-list" },
            multisample,
        });

        // ─── Marker pipeline (SDF circle/diamond) ───
        const markerCode = `
struct Uniforms { vp: mat4x4f, viewport: vec4f };
@group(0) @binding(0) var<uniform> u: Uniforms;

struct Marker {
    pos: vec4f,    // wx, wz, radius(px), shape
    fill: vec4f,
    stroke: vec4f,
    extras: vec4f, // strokeWidth(px), _, _, _
};
@group(1) @binding(0) var<storage, read> markers: array<Marker>;

struct VSOut {
    @builtin(position) pos: vec4f,
    @location(0) local: vec2f,  // physical pixels
    @location(1) fill: vec4f,
    @location(2) stroke: vec4f,
    @location(3) params: vec4f, // radius, strokeWidth, shape, _
};

@vertex
fn vs(@builtin(vertex_index) vid: u32, @builtin(instance_index) iid: u32) -> VSOut {
    let m = markers[iid];
    let wp = vec4f(m.pos.x, 0.0, m.pos.y, 1.0);
    let clip = u.vp * wp;
    let ndc = clip.xyz / clip.w;
    let halfVP = u.viewport.xy * 0.5;
    let centerPix = vec2f(ndc.x * halfVP.x, -ndc.y * halfVP.y);

    let radius = m.pos.z * u.viewport.z;
    let sw = m.extras.x * u.viewport.z;
    let pad = radius + sw * 0.5 + 2.0;

    var offset: vec2f;
    switch (vid) {
        case 0u: { offset = vec2f(-pad, -pad); }
        case 1u: { offset = vec2f( pad, -pad); }
        case 2u: { offset = vec2f(-pad,  pad); }
        case 3u: { offset = vec2f(-pad,  pad); }
        case 4u: { offset = vec2f( pad, -pad); }
        default: { offset = vec2f( pad,  pad); }
    }
    let pix = centerPix + offset;
    let ndc2 = vec2f(pix.x / halfVP.x, -pix.y / halfVP.y);

    var out: VSOut;
    out.pos = vec4f(ndc2 * clip.w, clip.z, clip.w);
    out.local = offset;
    out.fill = m.fill;
    out.stroke = m.stroke;
    out.params = vec4f(radius, sw, m.pos.w, 0.0);
    return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
    let r = in.params.x;
    let sw = in.params.y;
    let shape = in.params.z;

    var sd: f32;
    if (shape < 0.5) {
        sd = length(in.local) - r;
    } else if (shape < 1.5) {
        sd = abs(in.local.x) + abs(in.local.y) - r;
    } else {
        sd = max(abs(in.local.x), abs(in.local.y)) - r;
    }

    let halfSW = sw * 0.5;
    let fillMask   = 1.0 - smoothstep(-halfSW - 0.5, -halfSW + 0.5, sd);
    let outerMask  = 1.0 - smoothstep( halfSW - 0.5,  halfSW + 0.5, sd);
    let strokeMask = clamp(outerMask - fillMask, 0.0, 1.0);

    let aF = in.fill.a   * fillMask;
    let aS = in.stroke.a * strokeMask;
    let aTotal = aF + aS * (1.0 - aF);
    if (aTotal < 0.0005) { discard; }

    let rgb = (in.fill.rgb * aF + in.stroke.rgb * aS * (1.0 - aF)) / max(aTotal, 0.0001);
    return vec4f(rgb, aTotal);
}
`;

        const markerModule = device.createShaderModule({ code: markerCode });
        this.markerPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [camBGL, this.markerBGL] }),
            vertex: { module: markerModule, entryPoint: "vs" },
            fragment: { module: markerModule, entryPoint: "fs", targets },
            primitive: { topology: "triangle-list" },
            multisample,
        });
    }

    private ensureStorage(
        existing: GPUBuffer | null,
        capacity: number,
        neededBytes: number,
        bgl: GPUBindGroupLayout,
    ): { buffer: GPUBuffer; capacity: number; bindGroup: GPUBindGroup } {
        const device = this.device!;
        let buffer = existing;
        let cap = capacity;
        if (!buffer || neededBytes > cap) {
            buffer?.destroy();
            cap = Math.max(neededBytes, cap * 2, 1024);
            buffer = device.createBuffer({
                size: cap,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            });
        }
        const bindGroup = device.createBindGroup({
            layout: bgl,
            entries: [{ binding: 0, resource: { buffer } }],
        });
        return { buffer, capacity: cap, bindGroup };
    }

    render(
        viewProjection: mat4,
        lines: SketchLine[],
        quads: SketchQuad[],
        markers: SketchMarker[],
    ) {
        if (!this.initialized || !this.device || !this.context || !this.msaaView) return;
        const device = this.device;

        const uData = new Float32Array(24);
        uData.set(viewProjection as Float32Array, 0);
        uData[16] = this.widthPx;
        uData[17] = this.heightPx;
        uData[18] = this.dpr;
        uData[19] = 0;
        device.queue.writeBuffer(this.uniformBuffer!, 0, uData);

        // ── Pack lines ──
        if (lines.length > 0) {
            const arr = new Float32Array(lines.length * LINE_FLOATS);
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i];
                const o = i * LINE_FLOATS;
                arr[o + 0] = l.ax; arr[o + 1] = l.az;
                arr[o + 2] = l.bx; arr[o + 3] = l.bz;
                arr[o + 4] = l.color[0]; arr[o + 5] = l.color[1];
                arr[o + 6] = l.color[2]; arr[o + 7] = l.color[3];
                arr[o + 8] = l.width;
                arr[o + 9] = l.dash ?? 0;
                arr[o + 10] = l.dashRatio ?? 0.6;
                arr[o + 11] = 0;
            }
            const bytes = arr.byteLength;
            const res = this.ensureStorage(this.lineStorage, this.lineStorageCap, bytes, this.lineBGL);
            this.lineStorage = res.buffer;
            this.lineStorageCap = res.capacity;
            this.lineBindGroup = res.bindGroup;
            device.queue.writeBuffer(this.lineStorage, 0, arr);
        }

        // ── Pack quads ──
        if (quads.length > 0) {
            const arr = new Float32Array(quads.length * QUAD_FLOATS);
            for (let i = 0; i < quads.length; i++) {
                const q = quads[i];
                const o = i * QUAD_FLOATS;
                arr[o + 0] = q.p0[0]; arr[o + 1] = q.p0[1];
                arr[o + 2] = q.p1[0]; arr[o + 3] = q.p1[1];
                arr[o + 4] = q.p2[0]; arr[o + 5] = q.p2[1];
                arr[o + 6] = q.p3[0]; arr[o + 7] = q.p3[1];
                arr[o + 8]  = q.color[0]; arr[o + 9]  = q.color[1];
                arr[o + 10] = q.color[2]; arr[o + 11] = q.color[3];
            }
            const res = this.ensureStorage(this.quadStorage, this.quadStorageCap, arr.byteLength, this.quadBGL);
            this.quadStorage = res.buffer;
            this.quadStorageCap = res.capacity;
            this.quadBindGroup = res.bindGroup;
            device.queue.writeBuffer(this.quadStorage, 0, arr);
        }

        // ── Pack markers ──
        if (markers.length > 0) {
            const arr = new Float32Array(markers.length * MARKER_FLOATS);
            for (let i = 0; i < markers.length; i++) {
                const m = markers[i];
                const o = i * MARKER_FLOATS;
                arr[o + 0] = m.wx; arr[o + 1] = m.wz;
                arr[o + 2] = m.radius;
                arr[o + 3] = m.shape === "diamond" ? 1 : m.shape === "square" ? 2 : 0;
                arr[o + 4] = m.fill[0]; arr[o + 5] = m.fill[1];
                arr[o + 6] = m.fill[2]; arr[o + 7] = m.fill[3];
                arr[o + 8] = m.stroke[0]; arr[o + 9] = m.stroke[1];
                arr[o + 10] = m.stroke[2]; arr[o + 11] = m.stroke[3];
                arr[o + 12] = m.strokeWidth;
                arr[o + 13] = 0; arr[o + 14] = 0; arr[o + 15] = 0;
            }
            const res = this.ensureStorage(this.markerStorage, this.markerStorageCap, arr.byteLength, this.markerBGL);
            this.markerStorage = res.buffer;
            this.markerStorageCap = res.capacity;
            this.markerBindGroup = res.bindGroup;
            device.queue.writeBuffer(this.markerStorage, 0, arr);
        }

        const enc = device.createCommandEncoder();
        const pass = enc.beginRenderPass({
            colorAttachments: [{
                view: this.msaaView,
                resolveTarget: this.context.getCurrentTexture().createView(),
                loadOp: "clear",
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp: "store",
            }],
        });
        pass.setBindGroup(0, this.uniformBindGroup!);

        if (quads.length > 0 && this.quadBindGroup) {
            pass.setPipeline(this.quadPipeline!);
            pass.setBindGroup(1, this.quadBindGroup);
            pass.draw(6, quads.length);
        }
        if (lines.length > 0 && this.lineBindGroup) {
            pass.setPipeline(this.linePipeline!);
            pass.setBindGroup(1, this.lineBindGroup);
            pass.draw(6, lines.length);
        }
        if (markers.length > 0 && this.markerBindGroup) {
            pass.setPipeline(this.markerPipeline!);
            pass.setBindGroup(1, this.markerBindGroup);
            pass.draw(6, markers.length);
        }

        pass.end();
        device.queue.submit([enc.finish()]);
    }
}
