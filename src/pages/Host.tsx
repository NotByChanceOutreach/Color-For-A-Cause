import { Link } from "react-router-dom";
import { ArtImg, Crayon, Marker, Pencil } from "../components/ArtKit";

export function Host() {
  return (
    <div className="wrap section">
      <p className="kicker">Host an art day</p>
      <h1>Bring the crayons. We’ll bring the pictures.</h1>
      <div className="quiet-hero" style={{ margin: "1rem 0", position: "relative" }}>
        <div className="supplies" aria-hidden="true">
          <Crayon className="crayon-l" color="#c45a28" />
          <Marker className="crayon-r" />
          <Pencil className="pencil-r" />
        </div>
        <ArtImg src="/art/art-day.jpg" alt="A craft table with coloring pages, crayons, markers, and finished pictures." />
      </div>
      <p>
        Looking for a group activity? Print a set of pages, put out the art supplies, and let people make them their
        own. This is not therapy unless your organization independently chooses — and is qualified — to use it that way.
        Participation should be voluntary. Do not condition treatment, privileges, discharge, services, or rewards on
        coloring a page.
      </p>
      <ol>
        <li>Choose an easy, mixed, or custom pack.</li>
        <li>Print the instruction page with the QR code.</li>
        <li>People color. Messages optional. Personality welcome.</li>
        <li>Photograph finished pages and send them through the QR code, one after another.</li>
      </ol>
      <div className="btn-row">
        <Link className="btn" to="/packs">
          Choose a pack
        </Link>
        <Link className="btn btn-navy" to="/submit/group">
          Group submission mode
        </Link>
      </div>
    </div>
  );
}
