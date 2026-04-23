import { mat4 } from "gl-matrix";
import { Camera } from "./Camera";

export class PerspectiveCamera extends Camera {
    public fov: number = Math.PI / 4;
    public near: number = 0.1;
    public far: number = 1000.0;

    constructor(fov: number = Math.PI / 4, aspect: number = 1.0, near: number = 0.1, far: number = 1000.0) {
        super();
        this.fov = fov;
        this.aspect = aspect;
        this.near = near;
        this.far = far;
    }

    public updateProjectionMatrix(): void {
        mat4.perspective(this.projectionMatrix, this.fov, this.aspect, this.near, this.far);
    }
}
