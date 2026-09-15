import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { CONSENT_FIELDS, emptyPermissions } from "../data/consent";
import { api } from "../lib/api";
import { looksAllowed, makeDerivative } from "../lib/files";
import type { ConsentPermissions } from "../types";

type Row = {
  file?: File;
  preview?: string;
  name: string;
  message: string;
  perms: ConsentPermissions;
  number?: string;
};

export function GroupSubmit() {
  const [org, setOrg] = useState("");
  const [showOrg, setShowOrg] = useState(false);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function blank(): Row {
    return { name: "", message: "", perms: emptyPermissions() };
  }

  async function onFile(i: number, f?: File) {
    if (!f) return;
    const problem = looksAllowed(f);
    if (problem) return setErr(problem);
    const d = await makeDerivative(f, { maxEdge: 1400 });
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, file: f, preview: d.dataUrl } : r)));
  }

  async function send(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const group = await api.createGroup(org || "Group activity");
      const next = [...rows];
      for (let i = 0; i < next.length; i++) {
        const r = next[i];
        if (!r.file || !r.preview) continue;
        const sub = await api.submit({
          pageId: null,
          file: r.file,
          derivedDataUrl: r.preview,
          submitterRole: "organization",
          attributionKind: r.name.trim() ? "nickname" : "anonymous",
          attributionText: r.name,
          ageRange: "prefer_not",
          organizationName: org.trim() || null,
          showOrganization: showOrg,
          message: r.message,
          email: null,
          groupId: group.publicId,
          permissions: r.perms,
        });
        next[i] = { ...r, number: sub.number };
      }
      setRows(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send one of the pictures.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap section">
      <h1>Group submission</h1>
      <p>Organization information once. Then each picture. You do not have to name the organization in public.</p>
      {err && <div className="error-box">{err}</div>}
      <form className="form-card" onSubmit={send}>
        <label htmlFor="org">Group label (optional, can stay private)</label>
        <input id="org" value={org} onChange={(e) => setOrg(e.target.value)} />
        <label className="choice">
          <input type="checkbox" checked={showOrg} onChange={(e) => setShowOrg(e.target.checked)} />
          If art is approved, you may mention this group
        </label>
        {rows.map((r, i) => (
          <fieldset key={i}>
            <legend>Artwork {i + 1} {r.number ? `· ${r.number}` : ""}</legend>
            <input type="file" accept="image/*" onChange={(e) => onFile(i, e.target.files?.[0])} />
            {r.preview && <img src={r.preview} alt="" style={{ maxHeight: 240, marginTop: 8 }} />}
            <label>Artist name or nickname (optional)</label>
            <input value={r.name} onChange={(e) => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, name: e.target.value } : x)))} />
            <label>Message (optional)</label>
            <textarea value={r.message} onChange={(e) => setRows((rs) => rs.map((x, idx) => (idx === i ? { ...x, message: e.target.value } : x)))} />
            {CONSENT_FIELDS.filter((f) => ["store", "displayPublic", "showMessage", "collectible"].includes(f.key)).map((f) => (
              <label className="choice" key={f.key}>
                <input
                  type="checkbox"
                  checked={r.perms[f.key]}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((x, idx) =>
                        idx === i ? { ...x, perms: { ...x.perms, [f.key]: e.target.checked } } : x,
                      ),
                    )
                  }
                />
                {f.label}
              </label>
            ))}
          </fieldset>
        ))}
        <div className="btn-row">
          <button className="btn btn-ghost" type="button" onClick={() => setRows((r) => [...r, blank()])}>
            Add another artwork
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Sending…" : "Send this batch"}
          </button>
          <Link className="btn btn-ghost" to="/host">
            Back
          </Link>
        </div>
      </form>
    </div>
  );
}
