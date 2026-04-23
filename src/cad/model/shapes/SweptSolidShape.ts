import { Shape } from "./Shape";
import { Profile } from "../profiles/Profile";
import { Vec3 } from "../../geometry/math/Vec3";

export interface SweptSolidShape extends Shape {
    kind: "SweptSolid";
    profile: Profile;
    height: number;
    direction: Vec3;
}
