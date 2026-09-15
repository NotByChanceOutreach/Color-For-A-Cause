import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { pageBySlug, pngUrl } from "../data/pages";

export function PrintPage() {
  const { slug = "" } = useParams();
  const page = pageBySlug(slug);
  useEffect(() => {
    if (page) {
      const t = window.setTimeout(() => window.print(), 250);
      return () => window.clearTimeout(t);
    }
  }, [page]);
  if (!page) return <p>Missing page.</p>;
  return (
    <div className="print-sheet">
      <img className="lifting" src={pngUrl(page.slug)} alt={`Coloring page ${page.title} ready to print`} />
      <p className="no-print" style={{ marginTop: "1rem" }}>
        <Link className="btn" to={`/color/${page.slug}`}>
          Back
        </Link>
      </p>
    </div>
  );
}
