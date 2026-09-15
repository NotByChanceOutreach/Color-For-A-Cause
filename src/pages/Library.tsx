import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  COMPLEXITY_FILTERS,
  PAGES,
  THEME_FILTERS,
  emptyCatalogCopy,
  matchesCatalog,
  thumbUrl,
} from "../data/pages";
import { tiltFromId } from "../lib/ids";
import { track } from "../lib/analytics";
import { Pin, Tape } from "../components/ArtKit";
import type { Complexity, PageTag } from "../types";

export function Library() {
  const [complexity, setComplexity] = useState<Complexity | null>(null);
  const [theme, setTheme] = useState<PageTag | null>(null);
  const pages = useMemo(
    () => PAGES.filter((p) => matchesCatalog(p, complexity, theme)),
    [complexity, theme],
  );

  function pickComplexity(id: Complexity) {
    setComplexity(id);
  }

  function pickTheme(id: PageTag) {
    setTheme(id);
  }

  return (
    <div className="wrap section">
      <p className="kicker">Sketchbook</p>
      <h1>Choose a page</h1>
      <p>Easy, Standard, or Detailed — pick what feels good to color. Easy is not “for kids only.” It is just bigger shapes.</p>
      <div className="filters" role="group" aria-label="Complexity">
        {COMPLEXITY_FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={complexity === f.id} onClick={() => pickComplexity(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="filters" role="group" aria-label="Theme">
        {THEME_FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={theme === f.id} onClick={() => pickTheme(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      {pages.length === 0 ? (
        <div className="paper" role="status">
          <p>{emptyCatalogCopy(complexity, theme)}</p>
        </div>
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
