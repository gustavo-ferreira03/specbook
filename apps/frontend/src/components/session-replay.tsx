"use client";

import type { ReplayRecording } from "@specbook/runtime/replay-assets";
import type * as SharedReplay from "@specbook/runtime/replay-player";
import type { ReplayController } from "@specbook/runtime/replay-player";
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type ReplayPlayer from "rrweb-player";

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
  "--replay-tip-danger":
    "color-mix(in oklch, var(--sb-primary-foreground) 65%, var(--sb-danger))",
};

interface LoadedReplay {
  recording: ReplayRecording;
  shared: typeof SharedReplay;
  Player: typeof ReplayPlayer;
  styles: string;
}

export const SessionReplay = function SessionReplay({
  runId,
  failReason,
  controls,
  onReady,
}: {
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
    // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
    setError("");
    setLoaded(null);
    (async () => {
      try {
        const resolvedValue = await Promise.all([
          getRunReplay(runId, controller.signal),
          // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
          import("@specbook/runtime/replay-player"),
          // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
          import("@specbook/runtime/replay-player-styles"),
          // oxlint-disable-next-line react/todo -- Oxlint React Compiler cannot analyze this supported JavaScript syntax; preserve its cleanup and error behavior.
          import("rrweb-player"),
        ]);
        const [recording, shared, sharedStyles, player] = resolvedValue;
        if (!controller.signal.aborted) {
          setLoaded({
            recording,
            shared,
            Player: player.default,
            styles: sharedStyles.REPLAY_PLAYER_STYLES,
          });
        }
      } catch (error_) {
        if (!controller.signal.aborted && !isAbortError(error_)) {
          setError(errorMessage(error_));
        }
      }
    })();
    return () => controller.abort();
  }, [runId]);

  useEffect(() => {
    if (!loaded || !container.current) {
      return;
    }
    let mounted: ReplayController;
    try {
      mounted = loaded.shared.mountReplay(container.current, {
        recording: loaded.recording,
        Player: loaded.Player,
        waitMs: loaded.shared.assertionWait(failReason)?.ms,
      });
      // oxlint-disable-next-line react/immutability -- This mutable ref is the imperative playback controller and is only assigned inside the mounting effect.
      controls.current = mounted;
      onReady(mounted);
    } catch (error_) {
      // oxlint-disable-next-line react/set-state-in-effect -- Reset the previous request or selection when its external key changes before loading fresh state.
      setError(errorMessage(error_));
      return;
    }
    return () => {
      if (controls.current === mounted) {
        controls.current = null;
      }
      mounted.destroy();
    };
  }, [controls, failReason, loaded, onReady]);

  return (
    <section
      ref={container}
      className="replay min-w-0"
      style={playerTheme}
      aria-labelledby={`replay-${runId}`}
    >
      <style>{loaded?.styles}</style>
      <h3
        id={`replay-${runId}`}
        className="text-meta text-ink-muted flex items-center gap-1.5 font-semibold"
      >
        <Play size={13} aria-hidden="true" /> Replay
      </h3>
      <div className="replay-player mt-2" />
      <output className="replay-status text-meta text-ink-muted mt-2 block">
        {error ? `Could not load replay: ${error}` : "Loading replay…"}
      </output>
    </section>
  );
};
