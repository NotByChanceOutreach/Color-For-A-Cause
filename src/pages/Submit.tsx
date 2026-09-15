import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CONSENT_FIELDS, CONSENT_NOTICE, CONSENT_VERSION, MESSAGE_EXAMPLES, emptyPermissions } from "../data/consent";
import { PAGES, thumbUrl } from "../data/pages";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { fileToDataUrl, looksAllowed, makeDerivative } from "../lib/files";
import type { AgeRange, AttributionKind, ConsentPermissions, SubmitterRole } from "../types";

export function Submit() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [pageId, setPageId] = useState<string | null>(params.get("page"));
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [rotate, setRotate] = useState(0);
  const [cropPct, setCropPct] = useState(0);
  const [role, setRole] = useState<SubmitterRole>("self");
  const [attrKind, setAttrKind] = useState<AttributionKind>("firstName");
  const [attrText, setAttrText] = useState("");
  const [age, setAge] = useState<AgeRange>("prefer_not");
  const [org, setOrg] = useState("");
  const [showOrg, setShowOrg] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [perms, setPerms] = useState<ConsentPermissions>(emptyPermissions());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groupId = params.get("group");

  useEffect(() => {
    track("submission_started");
  }, []);

  async function onFile(f: File | undefined) {
    if (!f) return;
    const problem = looksAllowed(f);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setFile(f);
    try {
      const d = await makeDerivative(f, { maxEdge: 1600, rotate, cropPct });
      setPreview(d.dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That picture didn’t make it through.");
    }
  }

  useEffect(() => {
    if (!file) return;
    makeDerivative(file, { maxEdge: 1600, rotate, cropPct }).then((d) => setPreview(d.dataUrl)).catch(() => undefined);
  }, [rotate, cropPct, file]);

  const errors = useMemo(() => {
    const e: string[] = [];
    if (step >= 2 && !file) e.push("Please add a photo of the finished page.");
    if (step >= 4 && attrKind !== "anonymous" && !attrText.trim()) e.push("Type a first name, a nickname, or choose Anonymous.");
    if (step >= 6 && !perms.store) e.push("We need permission to store the artwork so we can receive it.");
    if (step >= 6 && role === "guardian" && (perms.displayPublic || perms.collectible) && !perms.store) {
      e.push("A grown-up needs to allow storage before public or collectible permissions.");
    }
    return e;
  }, [step, file, attrKind, attrText, perms.store, perms.displayPublic, perms.collectible, role]);

  async function finish(ev: FormEvent) {
    ev.preventDefault();
    if (errors.length || !file || !preview) {
      setError(errors[0] ?? "Please check the form.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const originalUrl = await fileToDataUrl(file);
      void originalUrl;
      const sub = await api.submit({
        pageId,
        file,
        derivedDataUrl: preview,
        submitterRole: role,
        attributionKind: attrKind,
        attributionText: attrKind === "anonymous" ? "" : attrText,
        ageRange: age,
        organizationName: org.trim() || null,
        showOrganization: showOrg && Boolean(org.trim()),
        message,
        email: email.trim() || null,
        groupId,
        permissions: perms,
      });
      track("submission_completed");
      nav(`/submit/success/${sub.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Whoops. That picture didn’t make it through. Let’s try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wrap section">
      <p className="kicker">Refrigerator door</p>
      <h1>Send us your art</h1>
      <p>About one or two minutes on a phone. No account.</p>
      {error && (
        <div className="error-box" role="alert" style={{ margin: "1rem 0" }}>
          <strong>Whoops.</strong>
          <p>{error}</p>
          <p>Your artwork is still safe on your device. Let’s try again.</p>
        </div>
      )}
      <form className="form-card" onSubmit={finish} method="post">
        {step === 1 && (
          <fieldset>
            <legend>Which picture did you color?</legend>
            <div className="gallery">
              <button type="button" className="page-card" onClick={() => setPageId(null)} aria-pressed={pageId === null}>
                <div style={{ aspectRatio: "8.5/11", display: "grid", placeItems: "center" }}>?</div>
                <figcaption>I don’t remember</figcaption>
              </button>
              {PAGES.map((p) => (
                <button
                  type="button"
                  className="page-card"
                  key={p.id}
                  onClick={() => setPageId(p.id)}
                  aria-pressed={pageId === p.id}
                >
                  <img src={thumbUrl(p.slug)} alt="" />
                  <figcaption>{p.title}</figcaption>
                </button>
              ))}
            </div>
            <p style={{ marginTop: "1rem" }}>
              <button className="btn" type="button" onClick={() => setStep(2)}>
                Next
              </button>
            </p>
          </fieldset>
        )}

        {step === 2 && (
          <fieldset>
            <legend>Upload your finished artwork</legend>
            <div className="drop">
              <div>
                <p>
                  <strong>Put your masterpiece here</strong>
                </p>
                <div className="btn-row" style={{ justifyContent: "center" }}>
                  <label className="btn">
                    Take a photo
                    <input
                      hidden
                      name="photo-camera"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                      capture="environment"
                      onChange={(e) => onFile(e.target.files?.[0])}
                    />
                  </label>
                  <label className="btn btn-ghost">
                    Choose a photo
                    <input
                      hidden
                      name="photo-file"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                      onChange={(e) => onFile(e.target.files?.[0])}
                    />
                  </label>
                </div>
              </div>
            </div>
            {preview && <img className="preview-art place-in" style={{ marginTop: "1rem" }} src={preview} alt="Preview of your artwork" />}
            <p style={{ marginTop: "1rem" }} className="btn-row">
              <button className="btn btn-ghost" type="button" onClick={() => setStep(1)}>
                Back
              </button>
              <button className="btn" type="button" onClick={() => setStep(3)} disabled={!file}>
                Next
              </button>
            </p>
          </fieldset>
        )}

        {step === 3 && (
          <fieldset>
            <legend>Look what you made!</legend>
            {preview && <img className="preview-art place-in" src={preview} alt="Your artwork" />}
            <p className="fine">We will not auto-fix, recolor, or “clean up” your art. Rotate only helps the photo sit straight.</p>
            <div className="btn-row">
              <button className="btn btn-ghost" type="button" onClick={() => setRotate((r) => r + 90)}>
                Rotate
              </button>
              <label htmlFor="crop">
                Crop edges
                <input
                  id="crop"
                  type="range"
                  min={0}
                  max={20}
                  value={Math.round(cropPct * 100)}
                  onChange={(e) => setCropPct(Number(e.target.value) / 100)}
                />
              </label>
              <button className="btn btn-ghost" type="button" onClick={() => { setFile(null); setPreview(null); setStep(2); }}>
                Replace photo
              </button>
            </div>
            <p className="btn-row" style={{ marginTop: "1rem" }}>
              <button className="btn btn-ghost" type="button" onClick={() => setStep(2)}>
                Back
              </button>
              <button className="btn" type="button" onClick={() => setStep(4)}>
                Next
              </button>
            </p>
          </fieldset>
        )}

        {step === 4 && (
          <fieldset>
            <legend>Who made this?</legend>
            <label htmlFor="role">Who created this artwork?</label>
            <select id="role" name="role" value={role} onChange={(e) => setRole(e.target.value as SubmitterRole)}>
              <option value="self">Me</option>
              <option value="guardian">My child / a minor I am responsible for</option>
              <option value="organization">Someone participating through my organization</option>
              <option value="someone_else">Someone else (I have permission)</option>
            </select>
            <fieldset>
              <legend>How should we name the artist in public, if we show it?</legend>
              <label className="choice">
                <input type="radio" name="attr" checked={attrKind === "firstName"} onChange={() => setAttrKind("firstName")} />
                First name
              </label>
              <label className="choice">
                <input type="radio" name="attr" checked={attrKind === "nickname"} onChange={() => setAttrKind("nickname")} />
                Nickname
              </label>
              <label className="choice">
                <input type="radio" name="attr" checked={attrKind === "anonymous"} onChange={() => setAttrKind("anonymous")} />
                Anonymous
              </label>
              {attrKind !== "anonymous" && (
                <>
                  <label htmlFor="attr">Name or nickname</label>
                  <input id="attr" name="attribution" value={attrText} onChange={(e) => setAttrText(e.target.value)} />
                </>
              )}
            </fieldset>
            <label htmlFor="age">Age range (optional)</label>
            <select id="age" name="age" value={age} onChange={(e) => setAge(e.target.value as AgeRange)}>
              <option value="prefer_not">Prefer not to say</option>
              <option value="under_13">Under 13</option>
              <option value="13_17">13–17</option>
              <option value="18_plus">18+</option>
            </select>
            <label htmlFor="org">Organization or group (optional)</label>
            <input id="org" name="organization" value={org} onChange={(e) => setOrg(e.target.value)} placeholder="school, community group, family…" />
            <label className="choice">
              <input type="checkbox" checked={showOrg} onChange={(e) => setShowOrg(e.target.checked)} />
              If the art is shown, you may mention this group (not required)
            </label>
            <p className="btn-row">
              <button className="btn btn-ghost" type="button" onClick={() => setStep(3)}>
                Back
              </button>
              <button className="btn" type="button" onClick={() => setStep(5)}>
                Next
              </button>
            </p>
          </fieldset>
        )}

        {step === 5 && (
          <fieldset>
            <legend>One more thing…</legend>
            <p>Want to say something with your art?</p>
            <label htmlFor="msg">Your message (optional)</label>
            <textarea id="msg" name="message" value={message} onChange={(e) => setMessage(e.target.value)} />
            <p className="fine">Ideas, not rules: {MESSAGE_EXAMPLES.join(" · ")} Or whatever you want.</p>
            <label htmlFor="email">Email if you want a note that we got it (optional)</label>
            <input id="email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            <p className="btn-row">
              <button className="btn btn-ghost" type="button" onClick={() => setStep(4)}>
                Back
              </button>
              <button className="btn" type="button" onClick={() => setStep(6)}>
                Next
              </button>
            </p>
          </fieldset>
        )}

        {step === 6 && (
          <fieldset>
            <legend>Permission</legend>
            <p className="fine">{CONSENT_NOTICE} Version {CONSENT_VERSION}.</p>
            {CONSENT_FIELDS.map((f) => (
              <label className="choice" key={f.key}>
                <input
                  type="checkbox"
                  name={f.key}
                  checked={perms[f.key]}
                  onChange={(e) => setPerms({ ...perms, [f.key]: e.target.checked })}
                />
                <span>
                  <strong>{f.label}</strong>
                  <br />
                  <span className="fine">{f.help}</span>
                </span>
              </label>
            ))}
            {errors.length > 0 && (
              <div className="error-box" role="alert">
                {errors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </div>
            )}
            <p className="btn-row">
              <button className="btn btn-ghost" type="button" onClick={() => setStep(5)}>
                Back
              </button>
              <button className="btn btn-rust" type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send it to Not By Chance"}
              </button>
            </p>
          </fieldset>
        )}
      </form>
      <p className="fine">
        <Link to="/consent">Read the full permission draft</Link>
      </p>
    </div>
  );
}
