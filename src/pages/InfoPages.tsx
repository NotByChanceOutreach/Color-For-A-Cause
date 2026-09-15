import { Link } from "react-router-dom";
import { CONSENT_FIELDS, CONSENT_NOTICE, CONSENT_VERSION } from "../data/consent";
import { api } from "../lib/api";
import { useEffect, useState } from "react";
import type { PublicCounters } from "../types";
import { ORG_HOME } from "../lib/copy";
import { ArtImg } from "../components/ArtKit";

export function GrownUps() {
  return (
    <div className="wrap section">
      <h1>For grown-ups</h1>
      <p>The short version, on paper scraps:</p>
      <ul className="grownup-list">
        <li>Printing is free. No account is needed to print.</li>
        <li>A child does not need a crypto wallet, an email, or a login.</li>
        <li>Nothing submitted appears publicly without a human review.</li>
        <li>Parent/guardian permission is required for minors before public display or a collectible.</li>
        <li>Nothing is automatically minted. Participation does not require blockchain knowledge.</li>
        <li>We do not ask for addresses, diagnoses, or treatment status.</li>
      </ul>
      <p>
        The 1-of-1 collectible idea is optional and explained separately. The main project is: print, color, send it
        back.
      </p>
      <div className="btn-row">
        <Link className="btn" to="/color">Choose a page</Link>
        <Link className="btn btn-ghost" to="/host">Host an art day</Link>
        <Link className="btn btn-ghost" to="/consent">Artwork permission</Link>
      </div>
    </div>
  );
}

export function About() {
  return (
    <div className="wrap section">
      <h1>About the 1-of-1 project</h1>
      <p>
        Every accepted piece is different because a person physically colored or painted it. Their authentic message
        can travel with the piece. If Not By Chance later creates a unique digital collectible from an approved work,
        that is a separate step. Submitting art does not automatically mint anything, and it does not promise funding,
        profit, resale value, or a tax result.
      </p>
      <p>Blockchain details, if they exist later, will live here as quiet facts — not the heart of the site.</p>
    </div>
  );
}

export function Impact() {
  const [c, setC] = useState<PublicCounters | null>(null);
  useEffect(() => {
    api.counters().then(setC);
  }, []);
  return (
    <div className="wrap section">
      <h1>How it helps</h1>
      <div className="quiet-hero" style={{ margin: "1rem 0" }}>
        <ArtImg src="/art/night-camp.jpg" alt="A tent, lantern, and sleeping bags in falling snow at night." />
      </div>
      <p>
        This playful art project exists because sleeping outside in winter is not playful. We will not show misery
        pictures or guilt marketing. Art creates something. That creation can help fund tents and sleeping bags
        distributed through Not By Chance Outreach.
      </p>
      <h2>Packages we may attach to a collectible</h2>
      <p>Package A: 1 pup tent + 2 sleeping bags. Package B: 1 full-size tent + 6 sleeping bags.</p>
      <p>Public numbers below only include verified records. Zeros mean we have not verified any yet — we will not invent totals.</p>
      {c && (
        <ul>
          <li>Artwork submitted: {c.artworkSubmitted}</li>
          <li>Artists participating (approved wall): {c.artistsParticipating}</li>
          <li>1-of-1 pieces created (verified): {c.collectiblesCreated}</li>
          <li>Tents funded (verified): {c.tentsFunded}</li>
          <li>Sleeping bags funded (verified): {c.sleepingBagsFunded}</li>
        </ul>
      )}
      <p>
        Learn more about outreach at{" "}
        <a href={ORG_HOME} rel="noreferrer">
          notbychanceoutreach.com
        </a>
        .
      </p>
    </div>
  );
}

export function Privacy() {
  return (
    <div className="wrap section">
      <h1>Privacy</h1>
      <p>Printing collects nothing. Submitting art collects only what you type and the photo you send.</p>
      <p>We do not want home addresses, GPS, diagnoses, recovery status, or classroom details. Public names are the ones you choose.</p>
      <p>Draft policy — legal review required before launch.</p>
    </div>
  );
}

export function ConsentPage() {
  return (
    <div className="wrap section">
      <h1>Artwork permission</h1>
      <p className="fine">{CONSENT_NOTICE} Version {CONSENT_VERSION}.</p>
      <ul>
        {CONSENT_FIELDS.map((f) => (
          <li key={f.key}>
            <strong>{f.label}</strong> — {f.help}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Standards() {
  return (
    <div className="wrap section">
      <h1>Community standards</h1>
      <p>
        We want weird, funny, tender, messy art. We do not publish hate, sexual content involving minors, threats,
        or other people’s private information. A human decides. “I like eating chalk” is not, by itself, a problem.
      </p>
    </div>
  );
}

export function AccessibilityPage() {
  return (
    <div className="wrap section">
      <h1>Accessibility</h1>
      <p>
        We aim for WCAG 2.2 AA: keyboard use, visible focus, labels, contrast, reduced motion, large tap targets, and
        plain language. If something is in the way, please tell us on the contact page.
      </p>
    </div>
  );
}

export function Contact() {
  return (
    <div className="wrap section">
      <h1>Contact</h1>
      <p>
        Outreach and general questions:{" "}
        <a href={ORG_HOME} rel="noreferrer">
          notbychanceoutreach.com
        </a>
      </p>
      <p>This community art app is a project of Not By Chance Outreach.</p>
    </div>
  );
}
