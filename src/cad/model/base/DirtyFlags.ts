export type DirtyFlag =
    | "Parameters"
    | "Topology"
    | "Geometry"
    | "Mesh"
    | "Render";

export type DirtyFlags = Set<DirtyFlag>;
