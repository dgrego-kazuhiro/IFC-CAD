import { MeshData } from "../../mesh/MeshData";

export class MeshBuffer {
    public sourceMesh: MeshData;
    public positionBuffer: GPUBuffer;
    public normalBuffer: GPUBuffer;
    public indexBuffer: GPUBuffer;
    public indexCount: number;
    public edgeIndexBuffer: GPUBuffer | null = null;
    public edgeIndexCount: number = 0;

    constructor(device: GPUDevice, meshData: MeshData) {
        this.sourceMesh = meshData;
        this.positionBuffer = device.createBuffer({
            size: meshData.positions.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.positionBuffer, 0, meshData.positions as any);

        this.normalBuffer = device.createBuffer({
            size: meshData.normals.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.normalBuffer, 0, meshData.normals as any);

        this.indexBuffer = device.createBuffer({
            size: meshData.indices.byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(this.indexBuffer, 0, meshData.indices as any);

        this.indexCount = meshData.indices.length;

        if (meshData.edgeIndices && meshData.edgeIndices.length > 0) {
            this.edgeIndexBuffer = device.createBuffer({
                size: meshData.edgeIndices.byteLength,
                usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
            });
            device.queue.writeBuffer(this.edgeIndexBuffer, 0, meshData.edgeIndices as any);
            this.edgeIndexCount = meshData.edgeIndices.length;
        }
    }

    public destroy() {
        this.positionBuffer.destroy();
        this.normalBuffer.destroy();
        this.indexBuffer.destroy();
        this.edgeIndexBuffer?.destroy();
    }
}
