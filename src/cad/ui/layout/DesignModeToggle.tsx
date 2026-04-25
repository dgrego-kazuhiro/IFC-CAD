"use client";

import React from "react";
import { useAppState, AppState, DesignMode } from "../../application/AppState";

const OPTIONS: { id: DesignMode; label: string; sub: string }[] = [
    { id: "freeZoning",        label: "自由ゾーニング", sub: "Free Zoning" },
    { id: "jpResidentialGrid", label: "日本住宅モード",  sub: "910 / 455mm Grid" },
];

export default function DesignModeToggle() {
    const designMode = useAppState((s: AppState) => s.designMode);
    const setDesignMode = useAppState((s: AppState) => s.setDesignMode);

    return (
        <div
            className="absolute bottom-4 left-4 flex items-stretch bg-zinc-800/95 backdrop-blur border border-zinc-600 rounded-lg shadow-xl overflow-hidden text-xs"
            style={{ zIndex: 25 }}
        >
            {OPTIONS.map((o) => {
                const active = o.id === designMode;
                return (
                    <button
                        key={o.id}
                        onClick={() => setDesignMode(o.id)}
                        className={
                            "flex flex-col items-start px-3 py-2 transition-colors " +
                            (active
                                ? "bg-blue-600/90 text-white"
                                : "bg-transparent text-zinc-300 hover:bg-zinc-700")
                        }
                    >
                        <span className="font-semibold leading-tight">{o.label}</span>
                        <span className={"text-[9px] " + (active ? "text-blue-100" : "text-zinc-500")}>{o.sub}</span>
                    </button>
                );
            })}
        </div>
    );
}
