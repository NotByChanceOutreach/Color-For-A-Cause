import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { tiltFromId } from "../lib/ids";
import { publicAttribution } from "../lib/copy";
import type { Submission } from "../types";
import { Peek, PencilWait, Pin, Tape } from "../components/ArtKit";

export function Wall() {
  const [items, setItems] = useState<Submission[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    api.listGallery().then(setItems).catch(() => setItems([])).finally(() => setReady(true));
  }, []);
  return (
    <div className="wrap section">
      <p className="kicker">Pinned, taped, and wonderfully uneven</p>
      <h1>The Art Wall</h1>
      <p>Only pieces a person at Not By Chance has approved appear here. Nothing goes up automatically.</p>
      {!ready && <PencilWait />}
      <div className="cork" style={{ marginTop: "1.2rem", position: "relative" }}>
        <Peek who="pup" side="left" />
        {ready && items.length === 0 && (
          <div className="paper">
            <h2>Looks like this part of the wall needs its first masterpiece.</h2>
            <p>Nothing here yet. Somebody has to be first.</p>
            <Link className="btn" to="/color">
              Make one
            </Link>
          </div>
        )}
        <div className="wall" style={{ marginTop: "1rem" }}>
          {items.map((s, i) => (
            <WallCard key={s.id} sub={s} variant={i % 3} />
          ))}
        </div>
      </div>
    </div>
  );
}

function WallCard({ sub, variant }: { sub: Submission; variant: number }) {
  const attr = publicAttribution({
    kind: sub.attributionKind,
    text: sub.attributionText,
    showAttribution: sub.permissions.showAttribution,
    org: sub.organizationName,
    showOrg: sub.showOrganization,
  });
  return (
    <Link className="wall-piece" to={`/wall/${sub.id}`} style={{ transform: `rotate(${tiltFromId(sub.id)}deg)` }}>
      {variant === 0 ? <Tape className="fastener" /> : variant === 1 ? <Pin className="fastener pinish" /> : <span className="tape" aria-hidden="true" />}
      <img src={sub.imageDataUrl} alt="" />
      <p>
        <strong>{attr.byline}</strong>
      </p>
      {sub.message && sub.permissions.showMessage && <p className="note">Artist says: “{sub.message}”</p>}
    </Link>
  );
}
