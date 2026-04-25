"use client";

import React, { useEffect, useState } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { ElementId } from "../../model/base/ElementId";
import { SpaceElement, RoomPolygon } from "../../model/elements/SpaceElement";
import { computeRoomMetrics, formatP } from "./roomMetrics";

/**
 * Properties panel shown while a room is being edited. Lets the user rename
 * the room (name + 用途 stored on the SpaceElement) and inspect 芯々寸法 /
 * P数 / 畳数 / 推定内法寸法 / 推定内法面積 derived from the first non-outline
 * polygon, per the new RoomGrid spec §10.
 */
export default function RoomPropertyPanel({ activeRoomId }: { activeRoomId: ElementId }) {
    const elements = useAppState((s: AppState) => s.elements);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const setActiveRoom = useAppState((s: AppState) => s.setActiveRoom);

    const room = elements[activeRoomId as string] as SpaceElement | undefined;
    const currentName = room?.name ?? "";
    const currentUsage = room?.usage ?? "";

    const [nameDraft, setNameDraft] = useState(currentName);
    const [usageDraft, setUsageDraft] = useState(currentUsage);
    // Only resync drafts when the room itself changes — otherwise an external
    // store update (e.g. solver writeback, or the partner field committing)
    // would overwrite whatever the user is currently typing.
    useEffect(() => {
        setNameDraft(currentName);
        setUsageDraft(currentUsage);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeRoomId]);

    const commitName = () => {
        const next = nameDraft.trim();
        if (next === currentName) return;
        // updateElement merges via { ...cur, ...partial }, so we have to
        // pass the *element id* (string), not anything wrapped — this is the
        // same call shape the rest of the codebase uses.
        updateElement(activeRoomId, { name: next });
    };
    const commitUsage = () => {
        const next = usageDraft.trim();
        if (next === currentUsage) return;
        updateElement(activeRoomId, { usage: next } as any);
    };

    if (!room || room.type !== "Space") return <div className="text-sm">No selection</div>;

    const anchor: RoomPolygon | null = (() => {
        for (const p of room.polygons ?? []) {
            if (p.wallOutlineOf) continue;
            if (!p.outer || p.outer.length < 3) continue;
            return p;
        }
        return null;
    })();
    const thickness = anchor?.wallThickness ?? 0.105;
    const m = anchor ? computeRoomMetrics(anchor, thickness) : null;
    const wallType = anchor?.wallIds?.some(Boolean) ? "間仕切壁" : "未設定";

    return (
        <div className="space-y-3 text-xs">
            <Field label="部屋名">
                <input
                    type="text"
                    value={nameDraft}
                    placeholder="Room name"
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") {
                            setNameDraft(currentName);
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className={inputCls}
                />
            </Field>

            <Field label="用途">
                <input
                    type="text"
                    list={`room-usage-options-${activeRoomId}`}
                    value={usageDraft}
                    placeholder="個室 / LDK / 収納 …"
                    onChange={(e) => setUsageDraft(e.target.value)}
                    onBlur={commitUsage}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") {
                            setUsageDraft(currentUsage);
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className={inputCls}
                />
                <datalist id={`room-usage-options-${activeRoomId}`}>
                    {["個室", "LDK", "寝室", "子ども室", "収納", "玄関", "洗面", "浴室", "WC", "廊下"].map((u) => (
                        <option key={u} value={u} />
                    ))}
                </datalist>
            </Field>

            {m && (
                <div className="rounded border border-zinc-800 bg-zinc-950/60 p-2 space-y-1">
                    <Row k="P数" v={`${formatP(m.pCountWidth)} × ${formatP(m.pCountDepth)}`} />
                    <Row k="芯々寸法" v={`${m.centerWidthMm.toLocaleString()} × ${m.centerDepthMm.toLocaleString()} mm`} />
                    <Row k="畳数" v={`約${m.tatami.toFixed(1)}畳`} />
                    <Row k="推定内法寸法" v={`${m.innerWidthMm.toLocaleString()} × ${m.innerDepthMm.toLocaleString()} mm`} />
                    <Row k="推定内法面積" v={`${m.innerAreaM2.toFixed(2)}㎡`} />
                    <Row k="芯々面積" v={`${m.centerAreaM2.toFixed(2)}㎡`} />
                    <Row k="壁タイプ" v={wallType} />
                </div>
            )}

            <div className="text-zinc-500">Polygons: {room.polygons?.length ?? 0}</div>
            <button
                className="w-full mt-2 px-2 py-1 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-300 text-xs"
                onClick={() => setActiveRoom(null)}
            >
                Exit Room Edit
            </button>
        </div>
    );
}

const inputCls = "w-full px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-zinc-100 text-xs outline-none focus:border-blue-500";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="text-[10px] text-zinc-500 uppercase font-semibold mb-1">{label}</div>
            {children}
        </div>
    );
}

function Row({ k, v }: { k: string; v: string }) {
    return (
        <div className="flex items-baseline justify-between gap-2">
            <span className="text-zinc-500 text-[10px] tracking-wide">{k}</span>
            <span className="text-zinc-200 text-[11px] font-medium tabular-nums text-right">{v}</span>
        </div>
    );
}
