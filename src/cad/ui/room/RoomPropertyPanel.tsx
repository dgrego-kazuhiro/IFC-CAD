"use client";

import React, { useState } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { ElementId } from "../../model/base/ElementId";
import { SpaceElement, RoomPolygon } from "../../model/elements/SpaceElement";
import { computeRoomMetrics, formatP } from "./roomMetrics";

/**
 * Properties panel shown for a selected / actively-edited room. The parent
 * (CadShell) passes a fresh `key={room.id}` so this component remounts on
 * every room switch — that means draft useState seeds straight from the new
 * room's name / usage and we don't need a useEffect to keep them in sync.
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

    const commitName = () => {
        const next = nameDraft.trim();
        if (next === currentName) return;
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
                {(() => {
                    const presetOptions = ["個室", "LDK", "寝室", "子ども室", "収納", "玄関", "洗面", "浴室", "WC", "廊下"];
                    // 現在値がプリセットに無ければ "__custom__" 扱いで自由入力欄を出す。
                    // datalist だと既存値で候補がフィルタされて他の選択肢が見えなく
                    // なる仕様だったので、明示的な <select> + 自由入力に分離する。
                    const isPreset = presetOptions.includes(usageDraft);
                    return (
                        <div className="space-y-1">
                            <select
                                value={isPreset ? usageDraft : (usageDraft ? "__custom__" : "")}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    if (v === "__custom__") {
                                        // 自由入力に切替 (現在値は維持)。
                                        if (isPreset) {
                                            setUsageDraft("");
                                            updateElement(activeRoomId, { usage: "" } as any);
                                        }
                                        return;
                                    }
                                    setUsageDraft(v);
                                    if (v !== currentUsage) {
                                        updateElement(activeRoomId, { usage: v } as any);
                                    }
                                }}
                                className={inputCls}
                            >
                                <option value="">未設定</option>
                                {presetOptions.map((u) => (
                                    <option key={u} value={u}>{u}</option>
                                ))}
                                <option value="__custom__">その他 (自由入力)</option>
                            </select>
                            {!isPreset && (
                                <input
                                    type="text"
                                    value={usageDraft}
                                    placeholder="自由入力"
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
                            )}
                        </div>
                    );
                })()}
            </Field>

            {m ? (
                <div className="rounded border border-zinc-800 bg-zinc-950/60 p-2 space-y-1">
                    <Row k="P数" v={`${formatP(m.pCountWidth)} × ${formatP(m.pCountDepth)}`} />
                    <Row k="芯々寸法" v={`${m.centerWidthMm.toLocaleString()} × ${m.centerDepthMm.toLocaleString()} mm`} />
                    <Row k="畳数" v={`約${m.tatami.toFixed(1)}畳`} />
                    <Row k="推定内法寸法" v={`${m.innerWidthMm.toLocaleString()} × ${m.innerDepthMm.toLocaleString()} mm`} />
                    <Row k="推定内法面積" v={`${m.innerAreaM2.toFixed(2)}㎡`} />
                    <Row k="芯々面積" v={`${m.centerAreaM2.toFixed(2)}㎡`} />
                    <Row k="壁タイプ" v={wallType} />
                </div>
            ) : (
                <div className="rounded border border-dashed border-zinc-700 bg-zinc-950/40 p-2 text-zinc-500">
                    部屋形状が未作成です。下の Rectangle / Polyline ツールで描画してください。
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
