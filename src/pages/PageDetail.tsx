import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { pageBySlug, pdfUrl, pngUrl, previewUrl } from "../data/pages";
import { track } from "../lib/analytics";
import { Brush, Clip, Crayon, Marker, PaintDot, Pencil } from "../components/ArtKit";

export function PageDetail() {
  const { slug = "" } = useParams();
  const page = pageBySlug(slug);
  const nav = useNavigate();
  const [lifting, setLifting] = useState(false);
  if (!page) {
    return (
      <div className="wrap section">
        <h1>We cannot find that page</h1>
        <Link to="/color">Choose another</Link>
      </div>
    );
  }
  return (
    <div className="wrap section">
      <p className="kicker">{page.complexity} · {page.tags.join(" · ")}</p>
      <h1>{page.title}</h1>
      <div className={lifting ? "detail-stage lifting" : "detail-stage"}>
        <div className="supplies" aria-hidden="true">
          <Crayon className="crayon-l" color="#c45a28" />
          <Crayon className="crayon-r" color="#3e74b0" />
          <Pencil className="pencil-r" />
          <Marker className="marker-l" />
          <Brush className="brush-t" />
          <Clip className="clip-t" />
          <PaintDot className="paint-bl" />
        </div>
        <img src={previewUrl(page.slug)} alt={`Printable coloring page: ${page.title}`} />
      </div>
      <div className="btn-row" style={{ marginTop: "1.1rem" }}>
        <button
          className="btn"
          type="button"
          onClick={() => {
            track("print_initiated", { slug: page.slug });
            setLifting(true);
            window.setTimeout(() => nav(`/print/${page.slug}`), 280);
          }}
        >
          Print me!
        </button>
        <a className="btn btn-ghost" href={pdfUrl(page.slug)} download onClick={() => track("pdf_downloaded", { slug: page.slug })}>
          Save the page
        </a>
        <a className="btn btn-ghost" href={pngUrl(page.slug)} download>
          Save the image
        </a>
        <Link className="btn btn-navy" to={`/submit?page=${page.id}`}>
          I already colored this one
        </Link>
        <Link className="btn btn-ghost" to="/color">
          Choose another
        </Link>
      </div>
      <p className="fine" style={{ marginTop: "1rem" }}>
        The printable page stays clean. All the crayons and doodles live on the website, not on your paper.
      </p>
    </div>
  );
}
