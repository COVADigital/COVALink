"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { EmbedInfo, embedFrameAttributes } from "@/features/blocks/embeds";

const noopSubscribe = () => () => {};

export interface EmbedPlayerProps {
  frame: ReturnType<typeof embedFrameAttributes>;
  box: EmbedInfo["box"];
  kind: EmbedInfo["kind"];
  label: string;
  /** The box's and the iframe's accessible name. */
  name: string;
  /** False in the editor preview, which never contacts a provider. */
  loadable: boolean;
}

/**
 * The click-to-load box. Until the visitor presses Load it holds
 * only local content, so a page with embeds contacts no provider; a fetched
 * thumbnail would itself be provider contact. The button appears after
 * hydration in a slot that's already reserved, so no inert control is shown
 * without JavaScript and nothing shifts. The loaded state lasts for this page
 * view and is stored nowhere. Nothing is drawn over the player.
 */
export function EmbedPlayer({ frame, box, kind, label, name, loadable }: EmbedPlayerProps) {
  const [loaded, setLoaded] = useState(false);
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    if (loaded) iframe.current?.focus();
  }, [loaded]);

  return (
    <div className="pp-embed-box" role="group" aria-label={name} data-box={box} style={box === "16:9" ? undefined : { minHeight: box }}>
      {loaded ? (
        <iframe ref={iframe} className="pp-embed-frame" title={name} {...frame} />
      ) : (
        <div className="pp-embed-placeholder">
          <svg className="pp-embed-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <path d={kind === "video" ? "M8 5v14l11-7z" : "M9 18V6l10-2v12a3 3 0 1 1-2-2.83V7.4l-6 1.2V18a3 3 0 1 1-2-2.83z"} />
          </svg>
          <p className="pp-embed-title">{name}</p>
          <p className="pp-embed-notice">Loads from {label}, which can then collect data about you.</p>
          <div className="pp-embed-action">
            {!loadable ? (
              <p className="pp-embed-notice">Visitors can load this player on your public page</p>
            ) : (
              hydrated && (
                <button type="button" className="pp-btn pp-embed-load" aria-label={`${kind === "video" ? "Load video" : "Load music player"}: ${name}`} onClick={() => setLoaded(true)}>
                  {kind === "video" ? "Load video" : "Load music player"}
                </button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
