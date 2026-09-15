import { useMemo, useState } from "react";
import { EASY_PACK, FULL_PACK, MIXED_PACK, PAGES, thumbUrl } from "../data/pages";
import { buildActivityPack, downloadBlob } from "../lib/packs";
import { api } from "../lib/api";
import { track } from "../lib/analytics";

export function Packs() {
  const [picked, setPicked] = useState<string[]>(MIXED_PACK);
  const [copies, setCopies] = useState(1);
  const [custom, setCustom] = useState("1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const n = useMemo(() => Math.min(50, Math.max(1, copies)), [copies]);

  async function go(slugs: string[], filename: string) {
    setBusy(true);
    setErr(null);
    try {
      const group = await api.createGroup("Activity pack");
      const blob = await buildActivityPack({
        slugs,
        copies: n,
        origin: window.location.origin,
        groupPublicId: group.publicId,
        includeInstructions: true,
      });
      downloadBlob(blob, filename);
      track("group_pack_generated", { pages: slugs.length, copies: n });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not build that pack.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(slug: string) {
    setPicked((cur) => (cur.includes(slug) ? cur.filter((s) => s !== slug) : [...cur, slug]));
  }

  return (
    <div className="wrap section">
      <p className="kicker">Bring the crayons. We’ll bring the pictures.</p>
      <h1>Print an activity pack</h1>
      <p>For families, schools, churches, community groups, and anyone hosting a table of paper.</p>
      {err && <div className="error-box">{err}</div>}
      <fieldset>
        <legend>How many copies of each page?</legend>
        {[1, 5, 10].map((c) => (
          <label className="choice" key={c}>
            <input type="radio" name="copies" checked={copies === c} onChange={() => { setCopies(c); setCustom(String(c)); }} />
            {c}
          </label>
        ))}
        <label htmlFor="custom">Custom</label>
        <input
          id="custom"
          type="number"
          min={1}
          max={50}
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            setCopies(Number(e.target.value) || 1);
          }}
        />
      </fieldset>
      <div className="btn-row">
        <button className="btn" type="button" disabled={busy} onClick={() => go(EASY_PACK, "easy-activity-pack.pdf")}>
          Easy activity pack
        </button>
        <button className="btn btn-navy" type="button" disabled={busy} onClick={() => go(MIXED_PACK, "mixed-activity-pack.pdf")}>
          Mixed activity pack
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => go(FULL_PACK, "full-collection.pdf")}>
          Full collection
        </button>
      </div>
      <h2 style={{ marginTop: "1.6rem" }}>Build your own</h2>
      <div className="sketch-table">
      <div className="gallery">
        {PAGES.map((p) => (
          <button
            type="button"
            key={p.id}
            className="page-card"
            aria-pressed={picked.includes(p.slug)}
            onClick={() => toggle(p.slug)}
          >
            <img src={thumbUrl(p.slug)} alt="" />
            <figcaption>
              {p.title} {picked.includes(p.slug) ? "✓" : ""}
            </figcaption>
          </button>
        ))}
      </div>
      </div>
      <p>
        <button className="btn btn-rust" type="button" disabled={busy || picked.length === 0} onClick={() => go(picked, "custom-activity-pack.pdf")}>
          {busy ? "Making the PDF…" : "Print selected pages"}
        </button>
      </p>
    </div>
  );
}
