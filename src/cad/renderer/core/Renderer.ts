import { GPUDeviceManager } from "./GPUDeviceManager";
import { RenderScene } from "./RenderScene";
import { Camera } from "../camera/Camera";
import { MeshBuffer } from "../buffers/MeshBuffer";
import { ElementId } from "../../model/base/ElementId";

const MSAA_COUNT = 4;

export class Renderer {
    private gpu: GPUDeviceManager;
    private scene: RenderScene;
    private camera: Camera;

    private pipeline: GPURenderPipeline | null = null;
    private linePipeline: GPURenderPipeline | null = null;
    private edgePipeline: GPURenderPipeline | null = null;
    private gridPipeline: GPURenderPipeline | null = null;
    // Renders objects marked `overlay: true` after the main pass with no
    // depth test / write and premultiplied-alpha blending so sketch lines
    // always sit on top of walls regardless of Y.
    private overlayPipeline: GPURenderPipeline | null = null;
    // Same as `pipeline` but with `cullMode: "none"`. Used for thin
    // double-sided geometry (door / window panels) whose face orientation
    // can't be guaranteed by the mesh builder.
    private noCullPipeline: GPURenderPipeline | null = null;

    private depthTexture: GPUTexture | null = null;
    private depthView: GPUTextureView | null = null;
    private msaaTexture: GPUTexture | null = null;
    private msaaView: GPUTextureView | null = null;

    private uniformBuffer: GPUBuffer | null = null;
    private uniformBindGroup: GPUBindGroup | null = null;

    private gridQuadBuffer: GPUBuffer | null = null;

    private meshBuffers = new Map<ElementId, MeshBuffer>();
    private objectUniformBuffers = new Map<ElementId, { buffer: GPUBuffer, bindGroup: GPUBindGroup }>();

    constructor(gpu: GPUDeviceManager, scene: RenderScene, camera: Camera) {
        this.gpu = gpu;
        this.scene = scene;
        this.camera = camera;
    }

    public setCamera(camera: Camera) {
        this.camera = camera;
    }

    public async init(canvas: HTMLCanvasElement): Promise<boolean> {
        const success = await this.gpu.init(canvas);
        if (!success) return false;

        await this.setupPipeline();
        this.resize(canvas.width, canvas.height);
        return true;
    }

    private async setupPipeline() {
        const device = this.gpu.device!;

        // ─── Main object shader ───
        const objectShaderCode = `
      struct Uniforms {
        viewProjectionMatrix: mat4x4f,
        eyePosition: vec4f,
      };

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct ObjectUniforms {
        modelMatrix: mat4x4f,
        color: vec4f,
        // flags.x = isCylinder flag (>0.5: position-derived radial normal を使う)
        // flags.yzw = cylinder の中心座標 (XYZ、Y は無視)
        flags: vec4f,
      };

      @group(1) @binding(0) var<uniform> objectUniforms: ObjectUniforms;

      struct VertexOutput {
        @builtin(position) position: vec4f,
        @location(0) color: vec4f,
        @location(1) normal: vec3f,
        @location(2) worldPos: vec3f,
      };

      @vertex
      fn vs_main(
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      ) -> VertexOutput {
        var output: VertexOutput;
        let worldP = objectUniforms.modelMatrix * vec4f(position, 1.0);
        output.worldPos = worldP.xyz;
        output.position = uniforms.viewProjectionMatrix * worldP;
        output.color = objectUniforms.color;
        let nm = mat3x3f(
          objectUniforms.modelMatrix[0].xyz,
          objectUniforms.modelMatrix[1].xyz,
          objectUniforms.modelMatrix[2].xyz
        );
        output.normal = normalize(nm * normal);
        return output;
      }

      @fragment
      fn fs_main(in: VertexOutput) -> @location(0) vec4f {
        // Blender 風の flat shading: 各 chord (= triangle pair) は同一面法線
        // を持つので、フラグメントシェーダでもそれをそのまま使う。位置由来の
        // radial 法線オーバーライドは per-pixel ノイズの原因になるため不採用。
        // 円柱は tessellation 細分化 (circleWallAngleDeg=3°) で滑らかに見せる。
        let n = normalize(in.normal);
        let lightDir = normalize(vec3f(0.4, 1.0, 0.3));
        let ambient = 0.65;
        let diff = max(0.0, dot(n, lightDir));
        let lighting = ambient + (1.0 - ambient) * diff;
        let finalColor = in.color.xyz * lighting;
        return vec4f(finalColor, in.color.a);
      }
    `;

        // ─── Edge shader ───
        const edgeShaderCode = `
      struct Uniforms {
        viewProjectionMatrix: mat4x4f,
        eyePosition: vec4f,
      };

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct ObjectUniforms {
        modelMatrix: mat4x4f,
        color: vec4f,
        flags: vec4f,
      };

      @group(1) @binding(0) var<uniform> objectUniforms: ObjectUniforms;

      struct EdgeOut {
        @builtin(position) position: vec4f,
      };

      @vertex
      fn vs_edge(
        @location(0) position: vec3f,
        @location(1) normal: vec3f
      ) -> EdgeOut {
        var out: EdgeOut;
        let worldP = objectUniforms.modelMatrix * vec4f(position, 1.0);
        out.position = uniforms.viewProjectionMatrix * worldP;
        out.position.z -= 0.00002 * out.position.w;
        return out;
      }

      @fragment
      fn fs_edge(in: EdgeOut) -> @location(0) vec4f {
        return vec4f(0.15, 0.15, 0.15, 1.0);
      }
    `;

        // ─── Grid shader ───
        const gridShaderCode = `
      struct Uniforms {
        viewProjectionMatrix: mat4x4f,
        eyePosition: vec4f,
      };

      @group(0) @binding(0) var<uniform> uniforms: Uniforms;

      struct GridOut {
        @builtin(position) position: vec4f,
        @location(0) worldXZ: vec2f,
      };

      @vertex
      fn vs_grid(@location(0) pos: vec3f) -> GridOut {
        var out: GridOut;
        let size = 500.0;
        let worldXZ = pos.xy * size + uniforms.eyePosition.xz;
        out.position = uniforms.viewProjectionMatrix * vec4f(worldXZ.x, -0.01, worldXZ.y, 1.0);
        out.worldXZ = worldXZ;
        return out;
      }

      @fragment
      fn fs_grid(in: GridOut) -> @location(0) vec4f {
        let coord1 = in.worldXZ / 1.0;
        let grid1 = abs(fract(coord1 - 0.5) - 0.5) / max(fwidth(coord1), vec2f(0.001));
        let line1 = min(grid1.x, grid1.y);
        let alpha1 = 1.0 - smoothstep(0.0, 1.0, line1);

        let coord10 = in.worldXZ / 10.0;
        let grid10 = abs(fract(coord10 - 0.5) - 0.5) / max(fwidth(coord10), vec2f(0.001));
        let line10 = min(grid10.x, grid10.y);
        let alpha10 = 1.0 - smoothstep(0.0, 1.5, line10);

        let dist = length(in.worldXZ - uniforms.eyePosition.xz);
        let fade = 1.0 - smoothstep(50.0, 200.0, dist);

        // Axis detection
        let axisX = abs(in.worldXZ.y) / max(fwidth(in.worldXZ).y, 0.001);
        let axisXAlpha = 1.0 - smoothstep(0.0, 1.0, axisX);
        let axisZ = abs(in.worldXZ.x) / max(fwidth(in.worldXZ).x, 0.001);
        let axisZAlpha = 1.0 - smoothstep(0.0, 1.0, axisZ);
        let onAxis = max(axisXAlpha, axisZAlpha);

        let gridAlpha = (alpha1 * 0.12 + alpha10 * 0.35) * (1.0 - onAxis);

        var final_alpha = gridAlpha * fade;
        var lineColor = vec3f(0.55);

        if (axisXAlpha > 0.01) {
          let a = axisXAlpha * 0.45 * fade;
          lineColor = mix(lineColor, vec3f(0.9, 0.5, 0.5), a / max(a, final_alpha + 0.001));
          final_alpha = max(final_alpha, a);
        }

        if (axisZAlpha > 0.01) {
          let a = axisZAlpha * 0.45 * fade;
          lineColor = mix(lineColor, vec3f(0.5, 0.6, 0.9), a / max(a, final_alpha + 0.001));
          final_alpha = max(final_alpha, a);
        }

        if (final_alpha < 0.005) { discard; }

        return vec4f(lineColor, final_alpha);
      }
    `;

        const objectModule = device.createShaderModule({ code: objectShaderCode });
        const edgeModule = device.createShaderModule({ code: edgeShaderCode });
        const gridModule = device.createShaderModule({ code: gridShaderCode });

        this.uniformBuffer = device.createBuffer({
            size: 96,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const bindGroupLayout0 = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }]
        });

        const bindGroupLayout1 = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }]
        });

        const pipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout0, bindGroupLayout1]
        });

        const gridPipelineLayout = device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout0]
        });

        const vertexBuffers: GPUVertexBufferLayout[] = [
            {
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }],
            },
            {
                arrayStride: 12,
                attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" as GPUVertexFormat }],
            }
        ];

        const msaa: GPUMultisampleState = { count: MSAA_COUNT };

        this.pipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: objectModule, entryPoint: "vs_main", buffers: vertexBuffers },
            fragment: { module: objectModule, entryPoint: "fs_main", targets: [{ format: this.gpu.format }] },
            primitive: { topology: "triangle-list", cullMode: "back" },
            depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth32float" },
            multisample: msaa,
        });

        this.noCullPipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: objectModule, entryPoint: "vs_main", buffers: vertexBuffers },
            fragment: { module: objectModule, entryPoint: "fs_main", targets: [{ format: this.gpu.format }] },
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth32float" },
            multisample: msaa,
        });

        this.overlayPipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: objectModule, entryPoint: "vs_main", buffers: vertexBuffers },
            fragment: {
                module: objectModule,
                entryPoint: "fs_main",
                targets: [{
                    format: this.gpu.format,
                    blend: {
                        color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                        alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                    },
                }],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: { depthWriteEnabled: false, depthCompare: "always", format: "depth32float" },
            multisample: msaa,
        });

        this.linePipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: objectModule, entryPoint: "vs_main", buffers: vertexBuffers },
            fragment: { module: objectModule, entryPoint: "fs_main", targets: [{ format: this.gpu.format }] },
            primitive: { topology: "line-list", cullMode: "none" },
            depthStencil: { depthWriteEnabled: true, depthCompare: "less", format: "depth32float" },
            multisample: msaa,
        });

        this.edgePipeline = device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module: edgeModule, entryPoint: "vs_edge", buffers: vertexBuffers },
            fragment: { module: edgeModule, entryPoint: "fs_edge", targets: [{ format: this.gpu.format }] },
            primitive: { topology: "line-list", cullMode: "none" },
            depthStencil: { depthWriteEnabled: true, depthCompare: "less-equal", format: "depth32float" },
            multisample: msaa,
        });

        this.gridPipeline = device.createRenderPipeline({
            layout: gridPipelineLayout,
            vertex: {
                module: gridModule,
                entryPoint: "vs_grid",
                buffers: [{
                    arrayStride: 12,
                    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }],
                }],
            },
            fragment: {
                module: gridModule,
                entryPoint: "fs_grid",
                targets: [{
                    format: this.gpu.format,
                    blend: {
                        color: { operation: "add", srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                        alpha: { operation: "add", srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                    },
                }],
            },
            primitive: { topology: "triangle-list", cullMode: "none" },
            depthStencil: { depthWriteEnabled: false, depthCompare: "less-equal", format: "depth32float" },
            multisample: msaa,
        });

        this.uniformBindGroup = device.createBindGroup({
            layout: bindGroupLayout0,
            entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
        });

        const quadVerts = new Float32Array([
            -1, -1, 0,   1, -1, 0,   -1, 1, 0,
            -1,  1, 0,   1, -1, 0,    1, 1, 0,
        ]);
        this.gridQuadBuffer = device.createBuffer({
            size: quadVerts.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.gridQuadBuffer, 0, quadVerts);
    }

    public resize(width: number, height: number) {
        if (!this.gpu.device) return;

        this.depthTexture?.destroy();
        this.depthTexture = this.gpu.device.createTexture({
            size: [width, height],
            format: "depth32float",
            sampleCount: MSAA_COUNT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.depthView = this.depthTexture.createView();

        this.msaaTexture?.destroy();
        this.msaaTexture = this.gpu.device.createTexture({
            size: [width, height],
            format: this.gpu.format,
            sampleCount: MSAA_COUNT,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.msaaView = this.msaaTexture.createView();
    }

    public render() {
        if (!this.gpu.device || !this.gpu.context || !this.pipeline || !this.msaaView) return;
        // Narrow the nullable members into locals so helper closures below
        // don't have to re-check them on every call.
        const device = this.gpu.device;
        const pipeline = this.pipeline;

        const uniformData = new Float32Array(24);
        uniformData.set(this.camera.viewProjectionMatrix as Float32Array, 0);
        uniformData[16] = this.camera.position[0];
        uniformData[17] = this.camera.position[1];
        uniformData[18] = this.camera.position[2];
        uniformData[19] = 0;
        device.queue.writeBuffer(this.uniformBuffer!, 0, uniformData);

        const resolveTarget = this.gpu.context.getCurrentTexture().createView();

        const commandEncoder = device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.msaaView,         // MSAA render target
                    resolveTarget: resolveTarget, // Resolve to swap chain
                    loadOp: "clear",
                    // 純白だと壁の上面 (= +Y 法線でほぼ最大照度) が背景と
                    // 同色になって「上面が描画されない」ように見える。off-white
                    // にして上面・slab・他の水平面を背景から区別可能にする。
                    clearValue: { r: 0.93, g: 0.94, b: 0.96, a: 1.0 },
                    storeOp: "store",
                },
            ],
            depthStencilAttachment: {
                view: this.depthView!,
                depthClearValue: 1.0,
                depthLoadOp: "clear",
                depthStoreOp: "store",
            },
        });

        passEncoder.setBindGroup(0, this.uniformBindGroup!);

        // Ensure per-object GPU resources exist and uniforms are up to date.
        // Returns the bind group + mesh buffer needed to draw `obj`.
        const prepareObject = (obj: import("./RenderScene").RenderObject): { meshBuf: MeshBuffer, bindGroup: GPUBindGroup } => {
            let meshBuf = this.meshBuffers.get(obj.id);
            if (meshBuf && meshBuf.sourceMesh !== obj.mesh) {
                meshBuf.destroy();
                this.meshBuffers.delete(obj.id);
                meshBuf = undefined;
            }
            if (!meshBuf) {
                meshBuf = new MeshBuffer(device, obj.mesh);
                this.meshBuffers.set(obj.id, meshBuf);
            }

            let objBuf = this.objectUniformBuffers.get(obj.id);
            if (!objBuf) {
                const buffer = device.createBuffer({
                    size: 96,
                    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                });
                const bindGroup = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: { buffer } }],
                });
                objBuf = { buffer, bindGroup };
                this.objectUniformBuffers.set(obj.id, objBuf);
            }

            const data = new Float32Array(24);
            data.set(obj.transform, 0);
            data.set(obj.color, 16);
            // flags: x=isCylinder, y=center.x, z=center.y, w=center.z
            if (obj.cylinderCenter) {
                data[20] = 1.0;
                data[21] = obj.cylinderCenter[0];
                data[22] = obj.cylinderCenter[1];
                data[23] = obj.cylinderCenter[2];
            } else {
                data[20] = 0.0;
                data[21] = 0.0;
                data[22] = 0.0;
                data[23] = 0.0;
            }

            device.queue.writeBuffer(objBuf.buffer, 0, data);
            return { meshBuf, bindGroup: objBuf.bindGroup };
        };

        // ─── Pass 1: Draw filled objects ───
        let currentPipeline: GPURenderPipeline | null = null;
        const edgeDraws: { meshBuf: MeshBuffer, bindGroup: GPUBindGroup }[] = [];
        const overlayDraws: { meshBuf: MeshBuffer, bindGroup: GPUBindGroup }[] = [];

        for (const obj of this.scene.getObjects()) {
            if (!obj.visible) continue;
            if (obj.id === "floor-grid") continue;

            if (obj.overlay) {
                // Deferred to the overlay pass so depth is irrelevant.
                const { meshBuf, bindGroup } = prepareObject(obj);
                overlayDraws.push({ meshBuf, bindGroup });
                continue;
            }

            const targetPipeline = obj.mesh.topology === "line-list"
                ? this.linePipeline!
                : (obj.noCull ? this.noCullPipeline! : this.pipeline!);
            if (currentPipeline !== targetPipeline) {
                currentPipeline = targetPipeline;
                passEncoder.setPipeline(currentPipeline);
            }

            const { meshBuf, bindGroup } = prepareObject(obj);

            passEncoder.setBindGroup(1, bindGroup);
            passEncoder.setVertexBuffer(0, meshBuf.positionBuffer);
            passEncoder.setVertexBuffer(1, meshBuf.normalBuffer);
            passEncoder.setIndexBuffer(meshBuf.indexBuffer, "uint32");
            passEncoder.drawIndexed(meshBuf.indexCount);

            if (meshBuf.edgeIndexBuffer && meshBuf.edgeIndexCount > 0) {
                edgeDraws.push({ meshBuf, bindGroup });
            }
        }

        // ─── Pass 2: Draw edges ───
        if (edgeDraws.length > 0) {
            passEncoder.setPipeline(this.edgePipeline!);
            for (const { meshBuf, bindGroup } of edgeDraws) {
                passEncoder.setBindGroup(1, bindGroup);
                passEncoder.setVertexBuffer(0, meshBuf.positionBuffer);
                passEncoder.setVertexBuffer(1, meshBuf.normalBuffer);
                passEncoder.setIndexBuffer(meshBuf.edgeIndexBuffer!, "uint32");
                passEncoder.drawIndexed(meshBuf.edgeIndexCount);
            }
        }

        // ─── Pass 3: Draw grid ───
        passEncoder.setPipeline(this.gridPipeline!);
        passEncoder.setBindGroup(0, this.uniformBindGroup!);
        passEncoder.setVertexBuffer(0, this.gridQuadBuffer!);
        passEncoder.draw(6);

        // ─── Pass 4: Draw overlay objects (always on top) ───
        if (overlayDraws.length > 0) {
            passEncoder.setPipeline(this.overlayPipeline!);
            passEncoder.setBindGroup(0, this.uniformBindGroup!);
            for (const { meshBuf, bindGroup } of overlayDraws) {
                passEncoder.setBindGroup(1, bindGroup);
                passEncoder.setVertexBuffer(0, meshBuf.positionBuffer);
                passEncoder.setVertexBuffer(1, meshBuf.normalBuffer);
                passEncoder.setIndexBuffer(meshBuf.indexBuffer, "uint32");
                passEncoder.drawIndexed(meshBuf.indexCount);
            }
        }

        passEncoder.end();
        device.queue.submit([commandEncoder.finish()]);
    }
}
