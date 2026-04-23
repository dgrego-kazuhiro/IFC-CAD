import { Vec3 } from "./Vec3";
import { AABB } from "../primitives/AABB";

export function rayIntersectsAABB(
    origin: Vec3, 
    dir: Vec3, 
    aabb: AABB
): number | null {
    let tmin = -Infinity;
    let tmax = Infinity;

    for (let i = 0; i < 3; i++) {
        if (dir[i] !== 0) {
            const t1 = (aabb.min[i] - origin[i]) / dir[i];
            const t2 = (aabb.max[i] - origin[i]) / dir[i];
            
            tmin = Math.max(tmin, Math.min(t1, t2));
            tmax = Math.min(tmax, Math.max(t1, t2));
        } else if (origin[i] < aabb.min[i] || origin[i] > aabb.max[i]) {
            return null; // Ray is parallel to plane and outside
        }
    }

    if (tmax >= tmin && tmax >= 0) {
        return tmin > 0 ? tmin : tmax;
    }
    return null;
}
