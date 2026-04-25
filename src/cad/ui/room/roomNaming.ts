import { BaseElement } from "../../model/base/BaseElement";

/**
 * Produce a fresh room name that doesn't collide with any existing Space
 * element's name. The default base is "Room"; pass `base="部屋"` (or any
 * other prefix) to use a Japanese-style name.
 *
 * The output is `${base} ${n}` for the smallest n ≥ 1 not already used.
 * Names are compared after `.trim()` so leading/trailing spaces don't
 * accidentally introduce collisions.
 */
export function pickNewRoomName(
    elements: Record<string, BaseElement>,
    base: string = "Room",
): string {
    const used = new Set<string>();
    for (const id in elements) {
        const el = elements[id];
        if (!el || el.type !== "Space") continue;
        const n = (el.name ?? "").trim();
        if (n) used.add(n);
    }
    for (let i = 1; ; i++) {
        const candidate = `${base} ${i}`;
        if (!used.has(candidate)) return candidate;
    }
}
