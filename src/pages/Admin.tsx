import { FormEvent, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate, useParams } from "react-router-dom";
import { api, useFirebase } from "../lib/api";
import { staffLoadError } from "../lib/staffErrors";
import { PAGES, previewUrl } from "../data/pages";
import type { AuditLog, Collectible, StaffRole, Submission, SubmissionStatus } from "../types";

/**
 * Loads one staff list. A role the rules don't allow gets "Your role can’t see this." instead of an empty
 * table or an unhandled rejection; any other failure gets a plain try-again line.
 */
function useStaffList<T>(load: () => Promise<T[]>): { rows: T[]; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ rows: T[]; error: string | null; loading: boolean }>({ rows: [], error: null, loading: true });
  useEffect(() => {
    let live = true;
    load()
      .then((rows) => live && setState({ rows, error: null, loading: false }))
      .catch((err: unknown) => live && setState({ rows: [], error: staffLoadError(err), loading: false }));
    return () => {
      live = false;
    };
    // The loaders are stable api methods: load once per mount.
  }, []);
  return state;
}

function StaffListError({ error }: { error: string }) {
  return (
    <p className="fine" role="status">
      {error}
    </p>
  );
}

export function StaffGate() {
  const [phase, setPhase] = useState<"wait" | "in" | "out">("wait");
  useEffect(() => {
    let live = true;
    void api.waitForStaff().then(() => {
      if (!live) return;
      setPhase(api.currentStaff() ? "in" : "out");
    });
    return () => {
      live = false;
    };
  }, []);
  if (phase === "wait") {
    return <p className="wrap section">Loading staff tools…</p>;
  }
  if (phase === "out") return <Navigate to="/staff/login" replace />;
  const staff = api.currentStaff();
  return (
    <div className="admin">
      <nav aria-label="Staff">
        <p>
          <strong>Staff</strong>
          <br />
          {staff?.email}
        </p>
        <NavLink to="/staff" end>
          Overview
        </NavLink>
        <NavLink to="/staff/submissions">Submissions</NavLink>
        <NavLink to="/staff/pages">Coloring pages</NavLink>
        <NavLink to="/staff/impact">Impact</NavLink>
        <NavLink to="/staff/logs">Audit log</NavLink>
        <button className="btn btn-ghost" type="button" style={{ marginTop: "1rem" }} onClick={() => { api.logout(); window.location.href = "/"; }}>
          Sign out
        </button>
      </nav>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

export function StaffLogin() {
  const nav = useNavigate();
  const firebase = useFirebase();
  const [email, setEmail] = useState(import.meta.env.DEV && !firebase ? "staff@localhost" : "");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.login(email, password);
      nav("/staff");
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Sign-in failed");
    }
  }
  return (
    <div className="wrap section">
      <h1>Staff sign-in</h1>
      {import.meta.env.DEV && !firebase && (
        <p className="fine">Local demo default: staff@localhost / local-dev-only</p>
      )}
      {firebase && (
        <p className="fine">Use your Not By Chance Outreach staff email. Public visitors never sign in here.</p>
      )}
      {import.meta.env.PROD && !firebase && (
        <p className="fine">Production staff sign-in is not connected in this build.</p>
      )}
      {err && <div className="error-box">{err}</div>}
      <form className="form-card" onSubmit={onSubmit}>
        <label htmlFor="em">Email</label>
        <input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        <label htmlFor="pw">Password</label>
        <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <button className="btn" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}

export function StaffHome() {
  const { rows: subs, error, loading } = useStaffList<Submission>(() => api.listAllSubmissions());
  const pending = subs.filter((s) => s.status === "submitted" || s.status === "hold" || s.status === "needs_changes");
  return (
    <>
      <h1>Overview</h1>
      {error ? (
        <StaffListError error={error} />
      ) : (
        <>
          <p>{loading ? "Loading…" : `${pending.length} waiting for a human look. ${subs.length} total received.`}</p>
          <Link className="btn" to="/staff/submissions">
            Review queue
          </Link>
        </>
      )}
    </>
  );
}

export function StaffSubmissions() {
  const { rows: subs, error } = useStaffList<Submission>(() => api.listAllSubmissions());
  if (error) {
    return (
      <>
        <h1>Submissions</h1>
        <StaffListError error={error} />
      </>
    );
  }
  return (
    <>
      <h1>Submissions</h1>
      <table>
        <thead>
          <tr>
            <th>Number</th>
            <th>Status</th>
            <th>Flags</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {subs.map((s) => (
            <tr key={s.id}>
              <td>
                <Link to={`/staff/submissions/${s.id}`}>{s.number}</Link>
              </td>
              <td>{s.status}</td>
              <td className="flag">{s.flags.join(", ") || "—"}</td>
              <td>{new Date(s.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

const ACTIONS: { status: SubmissionStatus; label: string; className: string }[] = [
  { status: "approved", label: "Approve", className: "btn" },
  { status: "featured", label: "Feature", className: "btn btn-navy" },
  { status: "needs_changes", label: "Request changes", className: "btn btn-ghost" },
  { status: "hold", label: "Hold", className: "btn btn-ghost" },
  { status: "rejected", label: "Reject", className: "btn btn-rust" },
  { status: "archived", label: "Archive", className: "btn btn-ghost" },
];

/** Mirrors canModerate in functions/src/moderate.ts; the server decides. */
function canModerate(role: StaffRole | undefined, from: SubmissionStatus, to: SubmissionStatus): boolean {
  if (role === "ADMIN" || role === "REVIEWER") return true;
  if (role === "ART_MANAGER") {
    return (from === "approved" && to === "featured") || (from === "featured" && to === "approved");
  }
  return false;
}

export function StaffReview() {
  const { id = "" } = useParams();
  const [sub, setSub] = useState<Submission | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getStaffSubmission(id)
      .then((s) => {
        if (!live) return;
        if (s) setSub(s);
        else setLoadError("We could not load this submission.");
      })
      .catch((err: unknown) => live && setLoadError(staffLoadError(err, "We could not load this submission.")));
    return () => {
      live = false;
    };
  }, [id]);

  // The server-made image arrives as an object URL from the reviewer's own authorized download.
  const imageUrl = sub?.imageDataUrl;
  useEffect(() => {
    return () => {
      if (imageUrl?.startsWith("blob:")) URL.revokeObjectURL(imageUrl);
    };
  }, [imageUrl]);

  if (!sub) return <p>{loadError ?? "Loading…"}</p>;
  const page = PAGES.find((p) => p.id === sub.pageId);
  const staff = api.currentStaff();
  const current = sub;
  const actions = ACTIONS.filter((a) => canModerate(staff?.role, current.status, a.status));

  async function act(status: SubmissionStatus) {
    if (status === "rejected" && !window.confirm("Reject this submission? The original file is still kept.")) return;
    setBusy(true);
    setErr(null);
    try {
      // derivedGeneration pins publishing to exactly the picture shown above.
      const next = await api.moderate(staff?.email ?? "staff", current.id, status, note, current.derivedGeneration ?? null);
      setSub(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That change did not save. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>
        <Link to="/staff/submissions">← Queue</Link>
      </p>
      <h1>{sub.number}</h1>
      <p>
        Status: <strong>{sub.status}</strong>
      </p>
      {sub.flags.length > 0 && <p className="flag">Flags: {sub.flags.join(", ")} — still a human decision.</p>}
      {sub.imageDataUrl ? (
        <img src={sub.imageDataUrl} alt="Submitted artwork" style={{ maxWidth: 420, border: "2px solid #000" }} />
      ) : (
        <p className="fine">The picture is not available yet.</p>
      )}
      {sub.stripped === false && (
        <p className="flag">This picture was sent before the server privacy check, so it cannot be published.</p>
      )}
      {page && (
        <p>
          Started as {page.title}
          <img src={previewUrl(page.slug)} alt="" style={{ width: 160 }} />
        </p>
      )}
      <ul>
        <li>Attribution: {sub.attributionKind} {sub.attributionText || "(anonymous)"}</li>
        <li>Role: {sub.submitterRole}</li>
        <li>Message: {sub.message || "—"}</li>
        <li>Org: {sub.organizationName || "—"}</li>
        <li>Original file: {sub.originalName || "—"} ({Math.round(sub.originalBytes / 1024)} KB)</li>
      </ul>
      <label htmlFor="note">Internal note</label>
      <textarea id="note" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      {err && (
        <div className="error-box" role="alert">
          {err}
        </div>
      )}
      <div className="btn-row">
        {actions.map((a) => (
          <button key={a.status} className={a.className} type="button" disabled={busy} onClick={() => act(a.status)}>
            {a.label}
          </button>
        ))}
      </div>
      {actions.length === 0 && <p className="fine">Your staff role can look at this piece but not change it.</p>}
    </>
  );
}

export function StaffPages() {
  return (
    <>
      <h1>Coloring pages</h1>
      <p>{PAGES.length} active library pages from the approved proof set.</p>
      <ul>
        {PAGES.map((p) => (
          <li key={p.id}>
            {p.id} {p.title} · {p.complexity}
          </li>
        ))}
      </ul>
    </>
  );
}

export function StaffImpact() {
  const { rows: cols, error } = useStaffList<Collectible>(() => api.listCollectibles());
  return (
    <>
      <h1>Impact</h1>
      <p>Attach Package A or B only when verified. Public counters ignore unverified rows.</p>
      {error ? <StaffListError error={error} /> : <p>Collectibles on file: {cols.length}. Minting is not enabled.</p>}
    </>
  );
}

export function StaffLogs() {
  const { rows, error } = useStaffList<AuditLog>(() => api.audits());
  if (error) {
    return (
      <>
        <h1>Audit log</h1>
        <StaffListError error={error} />
      </>
    );
  }
  return (
    <>
      <h1>Audit log</h1>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.at}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td>{r.target}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
