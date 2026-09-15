import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { Submission } from "../types";
import { Confetti, PencilWait, Tape } from "../components/ArtKit";

export function Success() {
  const { id = "" } = useParams();
  const [sub, setSub] = useState<Submission | null | undefined>(undefined);
  useEffect(() => {
    api.getSubmission(id).then((row) => setSub(row ?? null)).catch(() => setSub(null));
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
        <h1>You did it!</h1>
        <p>Your art is headed to Not By Chance. We’ll review it before anything is shared publicly.</p>
        <p className="fine">If you just sent it, you’re all set. We have it.</p>
        <div className="btn-row" style={{ marginTop: "1.2rem" }}>
          <Link className="btn" to="/submit">
            Make another
          </Link>
          <Link className="btn btn-ghost" to="/wall">
            See the Art Wall
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="wrap section">
      <Confetti />
      <p className="kicker">Stars, crayon bits, the works</p>
      <h1>You did it!</h1>
      <p>Your art is headed to Not By Chance. We’ll review it before anything is shared publicly.</p>
      <p>
        Your submission number: <strong>{sub.number}</strong>
      </p>
      <div className="art-frame">
        <Tape className="fastener" />
        <img src={sub.imageDataUrl} alt="The artwork you sent" />
      </div>
      <div className="btn-row" style={{ marginTop: "1.2rem" }}>
        <Link className="btn" to="/submit">
          Make another
        </Link>
        <Link className="btn btn-ghost" to="/wall">
          See the Art Wall
        </Link>
        <Link className="btn btn-navy" to="/">
          I’m done for now
        </Link>
      </div>
    </div>
  );
}
