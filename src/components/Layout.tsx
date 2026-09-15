import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { ORG_HOME } from "../lib/copy";
import { ArtImg, Snow } from "./ArtKit";

const LINKS = [
  { to: "/", label: "Home" },
  { to: "/color", label: "Color" },
  { to: "/submit", label: "Send your art" },
  { to: "/wall", label: "The Art Wall" },
  { to: "/impact", label: "How it helps" },
  { to: "/grown-ups", label: "Grown-ups" },
];

export function Layout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const print = loc.pathname.startsWith("/print/");

  useEffect(() => {
    const p = loc.pathname;
    let world = "line";
    if (p.startsWith("/color") || p.startsWith("/packs") || p.startsWith("/print")) world = "coloring";
    else if (p.startsWith("/submit") || p.startsWith("/wall") || p.startsWith("/host")) world = "human";
    else if (
      p.startsWith("/impact") ||
      p.startsWith("/grown") ||
      p.startsWith("/privacy") ||
      p.startsWith("/consent") ||
      p.startsWith("/about") ||
      p.startsWith("/staff")
    )
      world = "quiet";
    document.body.dataset.world = world;
  }, [loc.pathname]);

  if (print) return <Outlet />;

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <NavLink className="brand" to="/" onClick={() => setOpen(false)}>
          <img src="/art/pup-color.jpg" alt="" width={52} height={52} />
          <span className="brand-mark">
            <strong>Color For A Cause</strong>
            <span>Not By Chance Outreach</span>
          </span>
        </NavLink>
        <nav className="nav-desktop" aria-label="Primary">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.to === "/"}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <button className="menu-btn" type="button" aria-expanded={open} onClick={() => setOpen(true)}>
          Menu
        </button>
      </header>
      <div className={open ? "nav-sheet open" : "nav-sheet"} onClick={() => setOpen(false)}>
        <div className="nav-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Menu">
          <button className="btn btn-ghost" type="button" onClick={() => setOpen(false)}>
            Close
          </button>
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} onClick={() => setOpen(false)} end={l.to === "/"}>
              {l.label}
            </NavLink>
          ))}
          <NavLink to="/host" onClick={() => setOpen(false)}>
            Host an art day
          </NavLink>
        </div>
      </div>
      <main id="main">
        <Outlet />
      </main>
      <footer className="site-footer">
        <Snow count={8} />
        <ArtImg src="/art/night-camp.jpg" alt="A navy tent and sleeping bags under starlight, with a lantern glowing in the snow." />
        <div className="footer-copy wrap">
          <p className="kicker">Made with a lot of heart</p>
          <h2>And probably some crayon on the floor.</h2>
          <p>
            A project of{" "}
            <a href={ORG_HOME} rel="noreferrer">
              Not By Chance Outreach
            </a>
            . Printing is free. No account. No wallet.
          </p>
          <div className="legal-links">
            <NavLink to="/grown-ups">Grown-ups</NavLink>
            <NavLink to="/privacy">Privacy</NavLink>
            <NavLink to="/consent">Artwork permission</NavLink>
            <NavLink to="/standards">Community standards</NavLink>
            <NavLink to="/accessibility">Accessibility</NavLink>
            <NavLink to="/contact">Contact</NavLink>
            <NavLink to="/about">1-of-1 project</NavLink>
            <NavLink to="/staff">Staff</NavLink>
          </div>
        </div>
      </footer>
    </>
  );
}
