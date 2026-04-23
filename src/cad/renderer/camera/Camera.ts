import { mat4, vec3 } from "gl-matrix";

export abstract class Camera {
    public position: vec3 = vec3.fromValues(0, 0, 0);
    public target: vec3 = vec3.fromValues(0, 0, 0);
    public up: vec3 = vec3.fromValues(0, 1, 0);

    public viewMatrix: mat4 = mat4.create();
    public projectionMatrix: mat4 = mat4.create();
    public viewProjectionMatrix: mat4 = mat4.create();

    public aspect: number = 1.0;

    public abstract updateProjectionMatrix(): void;

    public updateViewMatrix(): void {
        mat4.lookAt(this.viewMatrix, this.position, this.target, this.up);
    }

    public update(): void {
        this.updateProjectionMatrix();
        this.updateViewMatrix();
        mat4.multiply(this.viewProjectionMatrix, this.projectionMatrix, this.viewMatrix);
    }
}
