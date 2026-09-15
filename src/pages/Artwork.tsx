import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { pageById, previewUrl } from "../data/pages";
import { api } from "../lib/api";
import { publicAttribution } from "../lib/copy";
import type { Submission } from "../types";
import { isPublicOnWall } from "../types";
import { PencilWait, Tape } from "../components/ArtKit";

export function Artwork() {
  const { id = "" } = useParams();
  const [sub, setSub] = useState<Submission | null | undefined>(undefined);
  useEffect(() => {
    api.getSubmission(id).then((s) => {
      if (!s || !isPublicOnWall(s)) setSub(null);
      else setSub(s);
    });
  }, [id]);
  if (sub === undefined) {
    return (
      <div className="wrap section">
        <PencilWait />
      </div>
    );
  }
  if (!sub) {
    return (
      <div className="wrap section">
        <h1>This piece is not on the wall</h1>
        <p>Nothing here yet. Somebody has to be first.</p>
        <Link to="/wall">Back to the Art Wall</Link>
      </div>
    );
  }
  const page = sub.pageId ? pageById(sub.pageId) : null;
  const attr = publicAttribution({
    kind: sub.attributionKind,
    text: sub.attributionText,
    showAttribution: sub.permissions.showAttribution,
    org: sub.organizationName,
    showOrg: sub.showOrganization,
  });
  return (
    <div className="wrap section">
      <p className="kicker">A tiny exhibit</p>
      <h1>Look what someone made</h1>
      <div className="art-frame">
        <Tape className="fastener" />
        <img src={sub.imageDataUrl} alt={`Finished artwork. ${attr.byline}`} />
      </div>
      <p>
        <strong>Made by</strong>
        <br />
        {attr.byline}
      </p>
      {attr.orgLine && <p>{attr.orgLine}</p>}
      {sub.message && sub.permissions.showMessage && (
        <p className="note">They said: “{sub.message}”</p>
      )}
      {page && <BeforeAfter blank={previewUrl(page.slug)} made={sub.imageDataUrl} title={page.title} />}
      <section style={{ marginTop: "1.5rem" }}>
        <h2>What this art can do</h2>
        <p>
          If Not By Chance later creates a 1-of-1 collectible from an approved piece, staff may attach Package A
          (1 pup tent + 2 sleeping bags) or Package B (1 full-size tent + 6 sleeping bags). That is not automatic,
          and it is not a promise about money.
        </p>
        <Link to="/about">About the 1-of-1 project</Link>
      </section>
    </div>
  );
}

function BeforeAfter({ blank, made, title }: { blank: string; made: string; title: string }) {
  const [pct, setPct] = useState(52);
  return (
    <section style={{ marginTop: "1.5rem" }}>
      <h2>This is where it started.</h2>
      <p>And this is what someone saw in it.</p>
      <div className="reveal" style={{ ["--full" as string]: "100%" }}>
        <img src={made} alt="What the artist created" />
        <div className="reveal-before" style={{ width: `${pct}%` }}>
          <img src={blank} alt={`Original blank page ${title}`} style={{ width: `${10000 / pct}%`, maxWidth: "none" }} />
        </div>
      </div>
      <label htmlFor="reveal">
        Drag to compare the blank page and the finished art
        <input
          id="reveal"
          type="range"
          min={8}
          max={92}
          value={pct}
          onChange={(e) => setPct(Number(e.target.value))}
        />
      </label>
      <p className="fine">The computer made the starting page. A person made the art.</p>
    </section>
  );
}
