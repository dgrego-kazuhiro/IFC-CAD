export class GPUDeviceManager {
    public adapter: GPUAdapter | null = null;
    public device: GPUDevice | null = null;
    public context: GPUCanvasContext | null = null;
    public format: GPUTextureFormat = "bgra8unorm";

    public async init(canvas: HTMLCanvasElement): Promise<boolean> {
        if (!navigator.gpu) {
            console.error("WebGPU not supported on this browser.");
            return false;
        }
        this.adapter = await navigator.gpu.requestAdapter({
            powerPreference: "high-performance",
        });
        if (!this.adapter) {
            console.error("No appropriate GPUAdapter found.");
            return false;
        }
        this.device = await this.adapter.requestDevice();
        this.context = canvas.getContext("webgpu");
        if (!this.context) {
            console.error("WebGPU context could not be created.");
            return false;
        }
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            alphaMode: "premultiplied",
        });
        return true;
    }
}
