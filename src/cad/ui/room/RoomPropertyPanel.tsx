"use client";

import React, { useEffect, useState } from "react";
import { useAppState, AppState } from "../../application/AppState";
import { ElementId } from "../../model/base/ElementId";
import { SpaceElement } from "../../model/elements/SpaceElement";

/**
 * Properties panel shown while a room is being edited. Lets the user rename
 * the room (name is stored on the SpaceElement) and inspect basic stats.
 */
export default function RoomPropertyPanel({ activeRoomId }: { activeRoomId: ElementId }) {
    const elements = useAppState((s: AppState) => s.elements);
    const updateElement = useAppState((s: AppState) => s.updateElement);
    const setActiveRoom = useAppState((s: AppState) => s.setActiveRoom);

    const room = elements[activeRoomId as string] as SpaceElement | undefined;
    const currentName = room?.name ?? "";

    // Local buffer so typing doesn't round-trip through the store on every
    // keystroke (and so we don't lose unsaved input if the room re-renders).
    const [nameDraft, setNameDraft] = useState(currentName);
    useEffect(() => {
        // Sync back when the room is swapped out (e.g. activeRoomId changes).
        setNameDraft(currentName);
    }, [activeRoomId, currentName]);

    const commit = () => {
        const next = nameDraft.trim();
        if (!next || next === currentName) return;
        updateElement(activeRoomId, { name: next });
    };

    if (!room || room.type !== "Space") return <div className="text-sm">No selection</div>;

    return (
        <div className="space-y-2 text-xs">
            <div>
                <div className="text-[10px] text-zinc-500 uppercase font-semibold mb-1">部屋名</div>
                <input
                    type="text"
                    value={nameDraft}
                    placeholder="Room name"
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            (e.target as HTMLInputElement).blur();
                        } else if (e.key === "Escape") {
                            setNameDraft(currentName);
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    className="w-full px-2 py-1 bg-zinc-950 border border-zinc-700 rounded text-zinc-100 text-xs outline-none focus:border-blue-500"
                />
            </div>
            <div className="text-zinc-500">Type: Space</div>
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
