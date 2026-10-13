"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Play } from "lucide-react";
import type { ReplayController } from "@specbook/runtime/replay-player";
import type { ReplayRecording } from "@specbook/runtime/replay-assets";
import { errorMessage, getRunReplay, isAbortError } from "@/lib/api";

const playerTheme: CSSProperties & Record<`--${string}`, string> = {
    "--ink": "var(--sb-ink)",
    "--muted": "var(--sb-ink-muted)",
    "--subtle": "var(--sb-ink-subtle)",
    "--line": "var(--sb-line)",
    "--strong": "var(--sb-line-strong)",
    "--primary": "var(--sb-primary)",
    "--primary-foreground": "var(--sb-primary-foreground)",
    "--success": "var(--sb-success)",
    "--success-soft": "var(--sb-success-soft)",
    "--danger": "var(--sb-danger)",
    "--danger-soft": "var(--sb-danger-soft)",
    "--surface": "var(--sb-surface)",
    "--soft": "var(--sb-surface-hover)",
    "--replay-tip-danger": "color-mix(in oklch, var(--sb-primary-foreground) 65%, var(--sb-danger))",
};

interface LoadedReplay {
    recording: ReplayRecording;
    shared: typeof import("@specbook/runtime/replay-player");
    Player: typeof import("rrweb-player")["default"];
    styles: string;
}

export function SessionReplay({ runId, failReason, controls, onReady }: {
    runId: string;
    failReason: string | null;
    controls: RefObject<ReplayController | null>;
    onReady: (controller: ReplayController) => void;
}) {
    const container = useRef<HTMLElement>(null);
    const [loaded, setLoaded] = useState<LoadedReplay | null>(null);
    const [error, setError] = useState("");

    useEffect(() => {
        const controller = new AbortController();
        setError("");
        setLoaded(null);
        void Promise.all([
            getRunReplay(runId, controller.signal),
            import("@specbook/runtime/replay-player"),
            import("@specbook/runtime/replay-player-styles"),
            import("rrweb-player"),
        ]).then(([recording, shared, sharedStyles, player]) => {
            if (!controller.signal.aborted) setLoaded({ recording, shared, Player: player.default, styles: sharedStyles.REPLAY_PLAYER_STYLES });
        }).catch((cause: unknown) => {
            if (!controller.signal.aborted && !isAbortError(cause)) setError(errorMessage(cause));
        });
        return () => controller.abort();
    }, [runId]);

    useEffect(() => {
        if (!loaded || !container.current) return;
        let mounted: ReplayController;
        try {
            mounted = loaded.shared.mountReplay(container.current, {
                recording: loaded.recording,
                Player: loaded.Player,
                waitMs: loaded.shared.assertionWait(failReason)?.ms,
            });
            controls.current = mounted;
            onReady(mounted);
        } catch (cause) {
            setError(errorMessage(cause));
            return;
        }
        return () => {
            if (controls.current === mounted) controls.current = null;
            mounted.destroy();
        };
    }, [controls, failReason, loaded, onReady]);

    return (
        <section ref={container} className="replay min-w-0" style={playerTheme} aria-labelledby={`replay-${runId}`}>
            <style>{loaded?.styles}</style>
            <h3 id={`replay-${runId}`} className="flex items-center gap-1.5 text-meta font-semibold text-ink-muted"><Play size={13} aria-hidden="true" /> Replay</h3>
            <div className="replay-player mt-2" />
            <p className="replay-status mt-2 text-meta text-ink-muted" role="status">{error ? `Could not load replay: ${error}` : "Loading replay…"}</p>
        </section>
    );
}
