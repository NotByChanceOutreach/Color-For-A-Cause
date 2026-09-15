import { FormEvent, useEffect, useState } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate, useParams } from "react-router-dom";
import { api, useFirebase } from "../lib/api";
import { PAGES, previewUrl } from "../data/pages";
import type { AuditLog, Collectible, Submission, SubmissionStatus } from "../types";

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
  const [subs, setSubs] = useState<Submission[]>([]);
  useEffect(() => {
    api.listAllSubmissions().then(setSubs);
  }, []);
  const pending = subs.filter((s) => s.status === "submitted" || s.status === "hold" || s.status === "needs_changes");
  return (
    <>
      <h1>Overview</h1>
      <p>{pending.length} waiting for a human look. {subs.length} total received.</p>
      <Link className="btn" to="/staff/submissions">
        Review queue
      </Link>
    </>
  );
}

export function StaffSubmissions() {
  const [subs, setSubs] = useState<Submission[]>([]);
  useEffect(() => {
    api.listAllSubmissions().then(setSubs);
  }, []);
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

export function StaffReview() {
  const { id = "" } = useParams();
  const [sub, setSub] = useState<Submission | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    api.getSubmission(id).then(setSub);
  }, [id]);
  if (!sub) return <p>Loading…</p>;
  const page = PAGES.find((p) => p.id === sub.pageId);
  const staff = api.currentStaff();
  const current = sub;
  async function act(status: SubmissionStatus) {
    if (status === "rejected" && !window.confirm("Reject this submission? The original file is still kept.")) return;
    const next = await api.moderate(staff?.email ?? "staff", current.id, status, note);
    setSub(next);
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
      <img src={sub.imageDataUrl} alt="Submitted artwork" style={{ maxWidth: 420, border: "2px solid #000" }} />
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
        <li>Original filename: {sub.originalName} ({Math.round(sub.originalBytes / 1024)} KB)</li>
      </ul>
      <label htmlFor="note">Internal note</label>
      <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="btn-row">
        <button className="btn" type="button" onClick={() => act("approved")}>
          Approve
        </button>
        <button className="btn btn-navy" type="button" onClick={() => act("featured")}>
          Feature
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => act("needs_changes")}>
          Request changes
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => act("hold")}>
          Hold
        </button>
        <button className="btn btn-rust" type="button" onClick={() => act("rejected")}>
          Reject
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => act("archived")}>
          Archive
        </button>
      </div>
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
  const [cols, setCols] = useState<Collectible[]>([]);
  useEffect(() => {
    api.listCollectibles().then(setCols);
  }, []);
  return (
    <>
      <h1>Impact</h1>
      <p>Attach Package A or B only when verified. Public counters ignore unverified rows.</p>
      <p>Collectibles on file: {cols.length}. Minting is not enabled.</p>
    </>
  );
}

export function StaffLogs() {
  const [rows, setRows] = useState<AuditLog[]>([]);
  useEffect(() => {
    api.audits().then(setRows);
  }, []);
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


