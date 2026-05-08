import { mat4 } from "gl-matrix";
import { Camera } from "./Camera";

export class PerspectiveCamera extends Camera {
    public fov: number = Math.PI / 4;
    public near: number = 0.1;
    // far を 1000 → 500 に短縮することで perspective 投影 (= 1/z 非線形) の
    // 深度精度を近距離寄りに集中させる。間取りの寸法 (= 通常 50m 以内) では
    // 500 で十分覆える。深度バッファ (= depth32float) 越しに発生していた
    // 微細な z-fighting / 法線補間ジッタを抑える狙い。
    public far: number = 500.0;

    constructor(fov: number = Math.PI / 4, aspect: number = 1.0, near: number = 0.1, far: number = 500.0) {
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
