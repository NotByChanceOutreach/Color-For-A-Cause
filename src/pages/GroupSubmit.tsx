import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { CONSENT_FIELDS, emptyPermissions } from "../data/consent";
import { api } from "../lib/api";
import { PHOTO_ACCEPT, looksAllowed, makeDerivative } from "../lib/files";
import {
  GUARDIAN_ATTESTATION_LABEL,
  GUARDIAN_ATTESTATION_REQUIRED,
  MINOR_LOCKED_KEYS,
  asksGuardianAttestation,
  lockPermissions,
  lockReason,
  minorLockApplies,
  needsGuardianAttestation,
} from "../lib/minors";
import { isNameRefusal, isPieceRefusal } from "../lib/refusals";
import { readableName } from "../lib/text";
import type { AgeRange, ConsentPermissions } from "../types";

type Row = {
  file?: File;
  preview?: string;
  name: string;
  message: string;
  age: AgeRange;
  perms: ConsentPermissions;
  number?: string;
  /** Why this row was not sent (the rest of the batch still was). */
  problem?: string;
};

export const UNREADABLE_NAME =
  "This name has no letters or numbers we can read. Type it again, or clear it to send the art without a name.";

/** A row whose store box is unticked: it is flagged and the rest of the batch still goes. */
export const STORE_NEEDED =
  "We need permission to store this picture in order to receive it. Tick “Not By Chance may store this artwork”, then send again.";

function blank(): Row {
  return { name: "", message: "", age: "prefer_not", perms: emptyPermissions() };
}

const ROLE = "organization" as const;

export function GroupSubmit() {
  const [org, setOrg] = useState("");
  const [showOrg, setShowOrg] = useState(false);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [guardianOk, setGuardianOk] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The group code the first press created. Pressing "Send this batch" again (after fixing a flagged row) reuses it,
  // so the whole batch stays one group and only one of the connection's hourly group codes is spent.
  const [groupCode, setGroupCode] = useState<string | null>(null);

  // Same rules the server enforces (functions/src/minors.ts). An artist whose age is unknown is treated as
  // possibly under 18: their row stays private unless the organization confirms a guardian agreed.
  const pending = rows.filter((r) => !r.number);
  const asksAttest = pending.some((r) => asksGuardianAttestation(r.age, ROLE));
  const mustAttest = pending.some((r) => r.file && needsGuardianAttestation(r.age, ROLE));
  const rowLocked = (r: Row) => minorLockApplies(r.age, ROLE, guardianOk) || (needsGuardianAttestation(r.age, ROLE) && !guardianOk);

  function update(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function onFile(i: number, f?: File) {
    if (!f) return;
    const problem = looksAllowed(f);
    if (problem) return setErr(problem);
    setErr(null);
    try {
      const d = await makeDerivative(f, { maxEdge: 1400 });
      update(i, { file: f, preview: d.dataUrl, problem: undefined });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "We could not open that picture. Try a JPG or PNG.");
    }
  }

  async function send(ev: FormEvent) {
    ev.preventDefault();
    if (mustAttest && !guardianOk) {
      setErr(GUARDIAN_ATTESTATION_REQUIRED);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      let groupId = groupCode;
      if (!groupId) {
        try {
          groupId = (await api.createGroup(org || "Group activity")).publicId;
          setGroupCode(groupId);
        } catch {
          // Group codes are rate-limited; the art still goes through, just without a group link.
          groupId = null;
        }
      }
      const next = [...rows];
      const skipped: number[] = [];
      const flag = (i: number, problem: string) => {
        next[i] = { ...next[i], problem };
        skipped.push(i + 1);
        setRows([...next]);
      };
      for (let i = 0; i < next.length; i++) {
        const r = next[i];
        if (!r.file || !r.preview || r.number) continue;
        // The store box is unticked on this row: it cannot be received. Flag it and send the rest of the batch.
        if (!r.perms.store) {
          flag(i, STORE_NEEDED);
          continue;
        }
        const locked = rowLocked(r);
        const typed = locked ? "" : r.name;
        const name = readableName(typed);
        // Something was typed but nothing in it is readable (only invisible or blank characters). The server would
        // refuse it, so this row is flagged and skipped while the rest of the batch still goes.
        if (!name && typed.trim() !== "") {
          flag(i, UNREADABLE_NAME);
          continue;
        }
        let sub;
        try {
          sub = await api.submit({
            pageId: null,
            file: r.file,
            previewDataUrl: r.preview,
            rotate: 0,
            cropPct: 0,
            submitterRole: ROLE,
            attributionKind: name ? "nickname" : "anonymous",
            attributionText: name ?? "",
            ageRange: r.age,
            organizationName: org.trim() || null,
            showOrganization: !locked && showOrg && Boolean(org.trim()),
            message: r.message,
            email: null,
            groupId,
            permissions: locked ? lockPermissions(r.perms) : r.perms,
            guardianConsentAttested: asksGuardianAttestation(r.age, ROLE) && guardianOk,
          });
        } catch (e) {
          // The server refused THIS piece (its name, its text, its choices): flag it, keep sending the others. The
          // server decides names: its Unicode tables may be older than this browser's, so a name the form accepted
          // can still be refused. Anything else (the connection, the server) stops the batch as before.
          if (!isPieceRefusal(e)) throw e;
          const serverSays = e.message;
          flag(i, isNameRefusal(e) ? UNREADABLE_NAME : serverSays);
          continue;
        }
        next[i] = { ...r, number: sub.number, problem: undefined };
        setRows([...next]);
      }
      if (skipped.length) {
        setErr(`Not sent yet: artwork ${skipped.join(", ")}. Check the note on each one, then press "Send this batch" again.`);
      }
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
        <input id="org" maxLength={120} value={org} onChange={(e) => setOrg(e.target.value)} />
        <label className="choice">
          <input type="checkbox" checked={showOrg} onChange={(e) => setShowOrg(e.target.checked)} />
          If art is approved, you may mention this group
        </label>
        {rows.map((r, i) => {
          const locked = !r.number && rowLocked(r);
          return (
            <fieldset key={i}>
              <legend>Artwork {i + 1} {r.number ? `· ${r.number}` : ""}</legend>
              <input type="file" accept={PHOTO_ACCEPT} aria-label={`Photo for artwork ${i + 1}`} onChange={(e) => onFile(i, e.target.files?.[0])} />
              {r.preview && <img src={r.preview} alt="" style={{ maxHeight: 240, marginTop: 8 }} />}
              <label htmlFor={`age-${i}`}>Age range (optional)</label>
              <select id={`age-${i}`} value={r.age} onChange={(e) => update(i, { age: e.target.value as AgeRange, problem: undefined })}>
                <option value="prefer_not">Prefer not to say</option>
                <option value="under_13">Under 13</option>
                <option value="13_17">13–17</option>
                <option value="18_plus">18+</option>
              </select>
              {locked ? (
                <p className="fine" role="note">
                  {lockReason(r.age, ROLE)}
                </p>
              ) : (
                <>
                  <label htmlFor={`name-${i}`}>Artist name or nickname (optional)</label>
                  <input
                    id={`name-${i}`}
                    maxLength={80}
                    value={r.name}
                    onChange={(e) => update(i, { name: e.target.value, problem: undefined })}
                  />
                </>
              )}
              {r.problem && (
                <p className="flag" role="alert">
                  {r.problem}
                </p>
              )}
              <label htmlFor={`msg-${i}`}>Message (optional)</label>
              <textarea
                id={`msg-${i}`}
                maxLength={2000}
                value={r.message}
                onChange={(e) => update(i, { message: e.target.value, problem: undefined })}
              />
              {CONSENT_FIELDS.filter((f) => ["store", "displayPublic", "showMessage", "collectible"].includes(f.key)).map((f) => {
                const off = locked && MINOR_LOCKED_KEYS.includes(f.key);
                return (
                  <label className="choice" key={f.key}>
                    <input
                      type="checkbox"
                      checked={off ? false : r.perms[f.key]}
                      disabled={off}
                      onChange={(e) => update(i, { perms: { ...r.perms, [f.key]: e.target.checked }, problem: undefined })}
                    />
                    {f.label}
                  </label>
                );
              })}
            </fieldset>
          );
        })}
        {asksAttest && (
          <label className="choice">
            <input type="checkbox" checked={guardianOk} onChange={(e) => setGuardianOk(e.target.checked)} />
            <span>
              <strong>{GUARDIAN_ATTESTATION_LABEL}</strong>
            </span>
          </label>
        )}
        <div className="btn-row">
          <button className="btn btn-ghost" type="button" onClick={() => setRows((r) => [...r, blank()])}>
            Add another artwork
          </button>
          <button className="btn" type="submit" disabled={busy || (mustAttest && !guardianOk)}>
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
