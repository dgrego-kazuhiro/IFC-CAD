import { mat4 } from "gl-matrix";
import { Camera } from "./Camera";

export class OrthographicCamera extends Camera {
    public zoom: number = 10.0; // Defines the half-width of the view
    public near: number = -1000.0;
    public far: number = 1000.0;

    constructor(zoom: number = 10.0, aspect: number = 1.0, near: number = -1000.0, far: number = 1000.0) {
        super();
        this.zoom = zoom;
        this.aspect = aspect;
        this.near = near;
        this.far = far;
    }

    public updateProjectionMatrix(): void {
        const left = -this.zoom * this.aspect;
        const right = this.zoom * this.aspect;
        const bottom = -this.zoom;
        const top = this.zoom;
        mat4.ortho(this.projectionMatrix, left, right, bottom, top, this.near, this.far);
    }
}
