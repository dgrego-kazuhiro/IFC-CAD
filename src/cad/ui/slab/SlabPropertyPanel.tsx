"use client";

import React, { useState, useEffect } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { SlabElement } from "../../model/elements/SlabElement";
import { ElementId } from "../../model/base/ElementId";

interface Props {
    slabId: ElementId;
}

export default function SlabPropertyPanel({ slabId }: Props) {
    const elements = useAppState((s: AppState) => s.elements);
    const levels = useAppState((s: AppState) => s.levels);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const removeElement = useAppState((s: AppState) => s.removeElement);
    const setSelection = useAppState((s: AppState) => s.setSelection);

    const slab = elements[slabId] as SlabElement | undefined;

    const [thicknessInput, setThicknessInput] = useState("");
    const [elevationInput, setElevationInput] = useState("");
    const [levelId, setLevelId] = useState<string | undefined>(undefined);

    // 選択 slab が変わったら入力欄を再シード。
    useEffect(() => {
        if (!slab || slab.type !== "Slab") return;
        setThicknessInput(slab.thickness.toString());
        setElevationInput(slab.elevation.toString());
        setLevelId(slab.levelId as string | undefined);
    }, [slabId, slab?.thickness, slab?.elevation, slab?.levelId]);

    if (!slab || slab.type !== "Slab") return null;

    const commitThickness = () => {
        const v = parseFloat(thicknessInput);
        if (Number.isFinite(v) && v > 0 && Math.abs(v - slab.thickness) > 1e-9) {
            updateElement(slabId, {
                thickness: v,
                dirtyFlags: new Set([...(slab.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
            } as any);
        } else {
            setThicknessInput(slab.thickness.toString());
        }
    };
    const commitElevation = () => {
        const v = parseFloat(elevationInput);
        if (Number.isFinite(v) && Math.abs(v - slab.elevation) > 1e-9) {
            updateElement(slabId, {
                elevation: v,
                dirtyFlags: new Set([...(slab.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
            } as any);
        } else {
            setElevationInput(slab.elevation.toString());
        }
    };
    const commitLevel = (next: string | undefined) => {
        setLevelId(next);
        updateElement(slabId, {
            levelId: (next ?? undefined) as any,
            dirtyFlags: new Set([...(slab.dirtyFlags ?? []), "Geometry", "Mesh", "Render"]),
        } as any);
    };

    return (
        <div className="space-y-3 text-xs">
            <div className="text-zinc-300 font-medium">{slab.name ?? "Slab"}</div>
            <div className="text-zinc-500">Type: Slab</div>

            <div>
                <label className="block text-zinc-400 mb-1">基準レベル</label>
                <select
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-zinc-100 outline-none focus:border-blue-500"
                    value={levelId ?? ""}
                    onChange={(e) => commitLevel(e.target.value || undefined)}
                >
                    <option value="">(none)</option>
                    {levels.map((l) => (
                        <option key={l.id as string} value={l.id as string}>
                            {l.name} ({(l.elevation * 1000).toFixed(0)}mm)
                        </option>
                    ))}
                </select>
            </div>

            <div>
                <label className="block text-zinc-400 mb-1">高さオフセット (m)</label>
                <input
                    type="number"
                    step="0.01"
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-zinc-100 outline-none focus:border-blue-500"
                    value={elevationInput}
                    onChange={(e) => setElevationInput(e.target.value)}
                    onBlur={commitElevation}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                />
            </div>

            <div>
                <label className="block text-zinc-400 mb-1">厚さ (m)</label>
                <input
                    type="number"
                    step="0.01"
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-zinc-100 outline-none focus:border-blue-500"
                    value={thicknessInput}
                    onChange={(e) => setThicknessInput(e.target.value)}
                    onBlur={commitThickness}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                />
            </div>

            <div className="text-zinc-500 text-[10px]">
                Outer: {slab.boundary.length} 頂点
                {slab.holes && slab.holes.length > 0 ? ` / Holes: ${slab.holes.length}` : ""}
            </div>

            <button
                className="w-full px-2 py-1 bg-red-700/60 hover:bg-red-600/60 rounded text-zinc-100"
                onClick={() => {
                    removeElement(slabId);
                    setSelection([]);
                }}
            >
                Slab を削除
            </button>
        </div>
    );
}
