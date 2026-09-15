import { Link } from "react-router-dom";
import { PAGES, thumbUrl } from "../data/pages";
import { api } from "../lib/api";
import { useEffect, useState } from "react";
import type { PublicCounters } from "../types";
import { ArtImg, Peek, Pin, Snow, Tape } from "../components/ArtKit";

const STEPS = [
  { n: "1", t: "Pick", d: "Choose a coloring page." },
  { n: "2", t: "Print", d: "At home, school, work, or a group." },
  { n: "3", t: "Create", d: "Crayons, markers, paint — whatever works." },
  { n: "4", t: "Say something", d: "Add a message if you want. Funny is fine." },
  { n: "5", t: "Send it back", d: "Photo or scan, then submit." },
  { n: "6", t: "We review it", d: "A person looks before anything is public." },
  { n: "7", t: "Art wall", d: "Approved pieces can hang on The Art Wall." },
  { n: "8", t: "Maybe 1-of-1", d: "Some approved art may join the collection. Not automatic." },
];

export function Home() {
  const [counts, setCounts] = useState<PublicCounters | null>(null);
  useEffect(() => {
    api.counters().then(setCounts);
  }, []);
  const featured = PAGES.filter((p) => p.featured).slice(0, 6);

  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <Snow count={12} />
        <ArtImg
          className="hero-scene"
          src="/art/hero.jpg"
          alt="A green pup tent and a rust sleeping-bag friend in a snowy forest at sunrise, with crayons, a lantern, and a blank coloring page in the snow."
        />
        <div className="hero-scrap">
          <p className="kicker">
            <span className="lantern" aria-hidden="true" /> Color For A Cause
          </p>
          <h1 id="hero-title">
            Color something
            <br />
            that can help
            <br />
            someone stay warm.
          </h1>
          <p className="lede">
            Pick a picture. Make it yours. Send it back.
            <br />
            Every finished piece is different because every person is different.
          </p>
          <div className="btn-row">
            <Link className="btn" to="/color">
              Let’s make something
            </Link>
            <Link className="btn btn-ghost" to="/submit">
              I already made mine
            </Link>
          </div>
        </div>
      </section>

      <section className="section wrap" aria-labelledby="how">
        <h2 id="how">How it works</h2>
        <p className="fine">Choose it → print it → make it yours → add your message → take a photo → send it back → we review it → approved art may join the 1-of-1 collection.</p>
        <div className="trail" style={{ marginTop: "1.2rem" }}>
          {STEPS.map((s) => (
            <div className="trail-step" key={s.n}>
              <span className="trail-num">{s.n}</span>
              <b>{s.t}</b>
              <span>{s.d}</span>
            </div>
          ))}
        </div>
        <p className="fine" style={{ marginTop: "0.8rem" }}>
          Use crayons. Markers. Paint. Colored pencils. Glitter if your grown-up is brave enough.
        </p>
      </section>

      <section className="section wrap" aria-labelledby="pages">
        <h2 id="pages">Pages waiting for you</h2>
        <p>Easy, standard, and detailed. Same friends. Different amounts of coloring.</p>
        <div className="sketch-table" style={{ marginTop: "1rem", position: "relative" }}>
          <Peek who="snug" side="right" />
          <div className="gallery">
            {featured.map((p, i) => (
              <Link
                className="page-card"
                key={p.id}
                to={`/color/${p.slug}`}
                style={{ transform: `rotate(${i % 2 ? 0.8 : -0.8}deg)` }}
              >
                {i % 2 ? <Tape className="fastener" /> : <Pin className="fastener pinish" />}
                <img src={thumbUrl(p.slug)} alt={`${p.title}, a ${p.complexity} coloring page`} />
                <span className="cta-peek">Color this one!</span>
                <figcaption>
                  {p.title} <span className="chip">{p.complexity}</span>
                </figcaption>
              </Link>
            ))}
          </div>
        </div>
        <p style={{ marginTop: "1.2rem" }}>
          <Link className="btn btn-navy" to="/color">
            See every page
          </Link>
        </p>
      </section>

      <section className="section wrap" aria-labelledby="help">
        <h2 id="help">What this art can support</h2>
        <p>
          Not By Chance Outreach brings shelter supplies to neighbors who are unhoused. If a piece becomes a
          1-of-1 collectible and is funded, staff can attach a real supply package. We only count packages that
          are verified. Submitting art does not guarantee funding.
        </p>
        <div className="packages" style={{ marginTop: "1rem" }}>
          <article className="pack-card">
            <p className="kicker">Package A</p>
            <h3>1 pup tent + 2 sleeping bags</h3>
            <p>A smaller shelter kit.</p>
          </article>
          <article className="pack-card">
            <p className="kicker">Package B</p>
            <h3>1 full-size tent + 6 sleeping bags</h3>
            <p>A larger shelter kit.</p>
          </article>
        </div>
        {counts && (
          <ul className="fine" style={{ marginTop: "1rem" }}>
            <li>Artwork submitted: {counts.artworkSubmitted}</li>
            <li>Verified tents funded: {counts.tentsFunded}</li>
            <li>Verified sleeping bags funded: {counts.sleepingBagsFunded}</li>
          </ul>
        )}
        <p style={{ marginTop: "1rem" }}>
          <Link className="btn btn-ghost" to="/impact">
            How it helps
          </Link>
        </p>
      </section>
    </>
  );
}
