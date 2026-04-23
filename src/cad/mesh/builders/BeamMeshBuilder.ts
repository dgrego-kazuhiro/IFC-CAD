import { MeshData } from "../MeshData";
import { AABB } from "../../geometry/primitives/AABB";
import { Vec3 } from "../../geometry/math/Vec3";
import { vec3 } from "gl-matrix";
import { BeamElement, BeamZJustification } from "../../model/elements/BeamElement";
import { Profile } from "../../model/profiles/Profile";

export interface BeamMeshParams {
    axis: [Vec3, Vec3];
    profile: Profile;
    /** Top elevation of the profile (= level elevation + topOffset). */
    topY: number;
    zJustification: BeamZJustification;
    rotation: number;
}

function profileBox(profile: Profile): { width: number; depth: number } {
    switch (profile.kind) {
        case "Rectangle":
            return { width: profile.width, depth: profile.depth };
        case "Circle":
            return { width: profile.radius * 2, depth: profile.radius * 2 };
        default:
            // MVP fallback for non-Rectangle profiles — use a default box
            return { width: 0.3, depth: 0.6 };
    }
}

/**
 * Build a beam mesh by extruding a rectangular profile along its 2-point axis.
 * - width: profile cross-dimension perpendicular to axis (horizontal)
 * - depth: profile cross-dimension along Y (vertical)
 * - zJustification anchors the profile's Top/Center/Bottom to `topY`
 * - rotation rotates the profile around the axis (radians)
 */
export class BeamMeshBuilder {
    public static buildFromElement(el: BeamElement, topY: number): MeshData {
        return BeamMeshBuilder.build({
            axis: el.axis,
            profile: el.profile,
            topY,
            zJustification: el.zJustification,
            rotation: el.rotation,
        });
    }

    public static build(p: BeamMeshParams): MeshData {
        const { axis, profile, topY, zJustification, rotation } = p;
        const [a, b] = axis;
        const dx = b[0] - a[0];
        const dz = b[2] - a[2];
        const lenXZ = Math.hypot(dx, dz);
        if (lenXZ < 1e-6) return emptyMesh();

        const { width, depth } = profileBox(profile);

        // Axis direction in XZ plane
        const tx = dx / lenXZ;
        const tz = dz / lenXZ;
        // Horizontal normal (right-perpendicular in XZ)
        const nx = -tz;
        const nz = tx;
        // Apply rotation around the axis: rotate (normal, up) in the plane
        // perpendicular to the axis. For MVP we treat rotation as a rotation
        // of the cross-section around the beam axis.
        const cr = Math.cos(rotation);
        const sr = Math.sin(rotation);
        const rNx = nx * cr;
        const rNz = nz * cr;
        const rNy = sr; // tilt up as rotation opens
        // Vertical-ish vector (perpendicular to both axis and rotated normal)
        // Start from world-up (0,1,0) and rotate by `rotation` around the axis.
        const uX = nx * -sr;
        const uY = cr;
        const uZ = nz * -sr;

        const halfW = width / 2;
        const halfD = depth / 2;
        // Anchor the profile vertically per zJustification so that `topY`
        // represents Top/Center/Bottom of the profile.
        let yCenter: number;
        switch (zJustification) {
            case "Top": yCenter = topY - halfD; break;
            case "Center": yCenter = topY; break;
            case "Bottom": yCenter = topY + halfD; break;
        }

        // 8 corners of the beam box
        const makeCorner = (tEnd: 0 | 1, sw: number, sv: number): Vec3 => {
            const base = tEnd === 0 ? a : b;
            return [
                base[0] + rNx * sw + uX * sv,
                yCenter + rNy * sw + uY * sv,
                base[2] + rNz * sw + uZ * sv,
            ];
        };

        const b0 = makeCorner(0, -halfW, -halfD);
        const b1 = makeCorner(0,  halfW, -halfD);
        const b2 = makeCorner(1,  halfW, -halfD);
        const b3 = makeCorner(1, -halfW, -halfD);
        const t0 = makeCorner(0, -halfW,  halfD);
        const t1 = makeCorner(0,  halfW,  halfD);
        const t2 = makeCorner(1,  halfW,  halfD);
        const t3 = makeCorner(1, -halfW,  halfD);

        const positions: number[] = [];
        const normals: number[] = [];
        const indices: number[] = [];
        const edges: number[] = [];
        let off = 0;

        const addFace = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3) => {
            positions.push(...p0, ...p1, ...p2, ...p3);
            const v1 = vec3.subtract(vec3.create(), p1, p0);
            const v2 = vec3.subtract(vec3.create(), p2, p1);
            const n = vec3.cross(vec3.create(), v1, v2);
            vec3.normalize(n, n);
            for (let i = 0; i < 4; i++) normals.push(...n);
            indices.push(off, off + 1, off + 2, off, off + 2, off + 3);
            edges.push(off, off + 1, off + 1, off + 2, off + 2, off + 3, off + 3, off);
            off += 4;
        };

        // 6 faces of the extruded box
        addFace(b0, b1, t1, t0); // start cap
        addFace(b2, b3, t3, t2); // end cap
        addFace(b1, b2, t2, t1); // +normal face
        addFace(b3, b0, t0, t3); // -normal face
        addFace(t0, t1, t2, t3); // top
        addFace(b3, b2, b1, b0); // bottom

        const posArray = new Float32Array(positions);
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        for (let i = 0; i < posArray.length; i += 3) {
            const x = posArray[i], y = posArray[i + 1], z = posArray[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const bounds: AABB = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };

        return {
            positions: posArray,
            normals: new Float32Array(normals),
            indices: new Uint32Array(indices),
            edgeIndices: new Uint32Array(edges),
            bounds,
        };
    }
}

function emptyMesh(): MeshData {
    return {
        positions: new Float32Array(),
        normals: new Float32Array(),
        indices: new Uint32Array(),
        edgeIndices: new Uint32Array(),
        bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    };
}
