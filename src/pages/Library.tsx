import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FILTERS, PAGES, matchesFilter, thumbUrl } from "../data/pages";
import { tiltFromId } from "../lib/ids";
import { track } from "../lib/analytics";
import { Pin, Tape } from "../components/ArtKit";

export function Library() {
  const [on, setOn] = useState<string[]>([]);
  const pages = useMemo(() => {
    if (!on.length) return PAGES;
    return PAGES.filter((p) => on.every((f) => matchesFilter(p, f)));
  }, [on]);

  function toggle(id: string) {
    setOn((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  return (
    <div className="wrap section">
      <p className="kicker">Sketchbook</p>
      <h1>Choose a page</h1>
      <p>Easy, standard, or detailed — pick what feels good to color. Easy is not “for kids only.” It is just bigger shapes.</p>
      <div className="filters" role="group" aria-label="Filter pages">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={on.includes(f.id)} onClick={() => toggle(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {pages.length === 0 ? (
        <p>Those labels hid every page. Try turning one off.</p>
      ) : (
        <div className="sketch-table">
          <div className="gallery">
            {pages.map((p, i) => (
              <Link
                className="page-card"
                key={p.id}
                to={`/color/${p.slug}`}
                style={{ transform: `rotate(${tiltFromId(p.id)}deg)` }}
                onClick={() => track("coloring_page_selected", { slug: p.slug })}
              >
                {i % 3 === 0 ? <Pin className="fastener pinish" /> : <Tape className="fastener" />}
                <img src={thumbUrl(p.slug)} alt={`${p.title}, ${p.complexity} coloring page`} loading="lazy" />
                <span className="cta-peek">Color this one!</span>
                <figcaption>
                  {p.title}
                  <div>
                    <span className="chip">{p.complexity}</span>
                  </div>
                </figcaption>
              </Link>
            ))}
          </div>
        </div>
      )}
      <p style={{ marginTop: "1.5rem" }}>
        <Link className="btn" to="/packs">
          Print an activity pack
        </Link>
      </p>
    </div>
  );
}
