import { vec3 } from "gl-matrix";
import { Camera } from "./Camera";

export class CameraController {
    private camera: Camera;
    private canvas: HTMLCanvasElement;

    private isDragging = false;
    private lastMouseX = 0;
    private lastMouseY = 0;

    constructor(camera: Camera, canvas: HTMLCanvasElement) {
        this.camera = camera;
        this.canvas = canvas;
        this.attachEvents();
    }

    public setCamera(camera: Camera) {
        this.camera = camera;
    }

    private attachEvents() {
        this.canvas.addEventListener("mousedown", this.onMouseDown);
        window.addEventListener("mouseup", this.onMouseUp);
        window.addEventListener("mousemove", this.onMouseMove);
        this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    }

    public detachEvents() {
        this.canvas.removeEventListener("mousedown", this.onMouseDown);
        window.removeEventListener("mouseup", this.onMouseUp);
        window.removeEventListener("mousemove", this.onMouseMove);
        this.canvas.removeEventListener("wheel", this.onWheel);
    }

    private onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0 && e.button !== 2 && e.button !== 1) return; // Allow interaction
        this.isDragging = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
    };

    private onMouseUp = () => {
        this.isDragging = false;
    };

    private onMouseMove = (e: MouseEvent) => {
        if (!this.isDragging) return;

        // Don't orbit on left click if a global flag is set (handled by Viewport)
        if (e.buttons === 1 && (window as any).__viewportInteracting) return;

        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (e.buttons === 1) { // Left click orbit
            // 2D モード (= OrthographicCamera) では視点回転を許可しない。
            // top-down 固定で作図する想定なので、回転すると平面位置が
            // ズレて作業にならない。pan / zoom は引き続き有効。
            // 判別は "zoom" プロパティの有無で行う (ortho 固有のプロパティ)。
            if (!("zoom" in this.camera)) {
                this.orbit(dx * 0.01, dy * 0.01);
            }
        } else if (e.buttons === 2 || e.buttons === 4) { // Right or middle click pan
            this.pan(dx, dy);
        }
    };

    private onWheel = (e: WheelEvent) => {
        e.preventDefault();
        this.zoom(e.deltaY * 0.005);
    };

    private orbit(dx: number, dy: number) {
        const dir = vec3.create();
        vec3.subtract(dir, this.camera.position, this.camera.target);
        const radius = vec3.length(dir);

        // azimuth and elevation
        let theta = Math.atan2(dir[0], dir[2]);
        let phi = Math.acos(dir[1] / radius);

        theta -= dx;
        phi -= dy;

        // clamp phi
        phi = Math.max(0.01, Math.min(Math.PI - 0.01, phi));

        dir[0] = radius * Math.sin(phi) * Math.sin(theta);
        dir[1] = radius * Math.cos(phi);
        dir[2] = radius * Math.sin(phi) * Math.cos(theta);

        vec3.add(this.camera.position, this.camera.target, dir);
        this.camera.update();
    }

    private pan(dx: number, dy: number) {
        let worldUnitsPerPixel = 0.01;
        const height = this.canvas.clientHeight || 1000;
        
        if ("zoom" in this.camera) {
            // Orthographic
            const orthoCam = this.camera as any;
            worldUnitsPerPixel = (2 * orthoCam.zoom) / height;
        } else if ("fov" in this.camera) {
            // Perspective
            const perspCam = this.camera as any;
            const dist = vec3.distance(this.camera.position, this.camera.target);
            worldUnitsPerPixel = (2 * dist * Math.tan(perspCam.fov / 2)) / height;
        }

        // Simple pan implementation
        const dir = vec3.create();
        vec3.subtract(dir, this.camera.target, this.camera.position);

        // Calculate right vector
        const right = vec3.create();
        vec3.cross(right, dir, this.camera.up);
        vec3.normalize(right, right);

        // Calculate actual up vector relative to camera 
        const up = vec3.create();
        vec3.cross(up, right, dir);
        vec3.normalize(up, up);

        const panRight = vec3.create();
        vec3.scale(panRight, right, -dx * worldUnitsPerPixel);

        const panUp = vec3.create();
        vec3.scale(panUp, up, dy * worldUnitsPerPixel);

        const panTotal = vec3.create();
        vec3.add(panTotal, panRight, panUp);

        vec3.add(this.camera.position, this.camera.position, panTotal);
        vec3.add(this.camera.target, this.camera.target, panTotal);
        this.camera.update();
    }

    private zoom(delta: number) {
        if ("zoom" in this.camera) {
            // It's an OrthographicCamera
            const orthoCam = this.camera as any;
            orthoCam.zoom *= (1.0 + delta);
            orthoCam.zoom = Math.max(0.1, orthoCam.zoom);
            this.camera.update();
        } else {
            // PerspectiveCamera
            const dir = vec3.create();
            vec3.subtract(dir, this.camera.position, this.camera.target);
            const len = vec3.length(dir);

            let newLen = len * (1.0 + delta);
            newLen = Math.max(0.1, newLen);

            vec3.normalize(dir, dir);
            vec3.scale(dir, dir, newLen);

            vec3.add(this.camera.position, this.camera.target, dir);
            this.camera.update();
        }
    }
}
