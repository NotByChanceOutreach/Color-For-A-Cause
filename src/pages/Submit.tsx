import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { CONSENT_FIELDS, CONSENT_NOTICE, CONSENT_VERSION, MESSAGE_EXAMPLES, emptyPermissions } from "../data/consent";
import { PAGES, thumbUrl } from "../data/pages";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { PHOTO_ACCEPT, looksAllowed, makeDerivative } from "../lib/files";
import {
  GUARDIAN_ATTESTATION_LABEL,
  MINOR_LOCKED_KEYS,
  asksGuardianAttestation,
  emailReason,
  lockPermissions,
  lockReason,
  minorLockApplies,
  needsGuardianAttestation,
} from "../lib/minors";
import { isNameRefusal } from "../lib/refusals";
import { readableName } from "../lib/text";
import type { AgeRange, AttributionKind, ConsentPermissions, SubmitterRole } from "../types";

const GROUP_CODE = /^[0-9a-f]{12}$/;

export function Submit() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [pageId, setPageId] = useState<string | null>(() => {
    const requested = params.get("page");
    return requested && PAGES.some((p) => p.id === requested) ? requested : null;
  });
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
  const [guardianOk, setGuardianOk] = useState(false);
  const [groupId, setGroupId] = useState<string | null>(null);
  const [groupLabel, setGroupLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The server's refusal of the name, shown at the name question. */
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const groupParam = params.get("group");
  // Same rules the server enforces (functions/src/minors.ts); here they only explain themselves.
  // Protective default: until we know the artist is 18+, or a guardian (or an organization that confirms a
  // guardian agreed) is sending, everything public stays off and the public-naming question is hidden.
  const locked = minorLockApplies(age, role, guardianOk);
  const asksAttest = asksGuardianAttestation(age, role);
  const needsAttest = needsGuardianAttestation(age, role);
  // An organization unlocks the naming question on the permission step (the guardian box is there), so the question
  // is asked there too: nobody has to go back two steps to answer it.
  const nameOnPermissionStep = asksAttest && !locked;

  useEffect(() => {
    track("submission_started");
  }, []);

  // Only a group code the server knows is attached. An old QR code still lets people send art.
  useEffect(() => {
    if (!groupParam || !GROUP_CODE.test(groupParam)) return;
    let live = true;
    api
      .getGroupByPublicId(groupParam)
      .then((g) => {
        if (live && g) {
          setGroupId(g.publicId);
          setGroupLabel(g.label);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [groupParam]);

  useEffect(() => {
    if (!locked) return;
    setPerms((p) => lockPermissions(p));
    setShowOrg(false);
    setEmail("");
  }, [locked]);

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
    // Judged like the server does: a name of only invisible or blank characters is no name.
    if (step >= 4 && !locked && attrKind !== "anonymous" && !readableName(attrText)) e.push("Type a first name, a nickname, or choose Anonymous.");
    if (step >= 6 && !perms.store) e.push("We need permission to store the artwork so we can receive it.");
    if (step >= 6 && role === "guardian" && (perms.displayPublic || perms.collectible) && !perms.store) {
      e.push("A grown-up needs to allow storage before public or collectible permissions.");
    }
    if (step >= 6 && needsAttest && !guardianOk) {
      e.push("Please confirm a parent or guardian agreed, or change who is sending the art.");
    }
    return e;
  }, [step, file, attrKind, attrText, locked, perms.store, perms.displayPublic, perms.collectible, role, needsAttest, guardianOk]);

  async function finish(ev: FormEvent) {
    ev.preventDefault();
    if (errors.length || !file || !preview) {
      setError(errors[0] ?? "Please check the form.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const quarterTurn = (((rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270;
      const sub = await api.submit({
        pageId,
        file,
        previewDataUrl: preview,
        rotate: quarterTurn,
        cropPct,
        submitterRole: role,
        // While locked the public-naming question is hidden, so no name is sent.
        attributionKind: locked ? "anonymous" : attrKind,
        attributionText: locked || attrKind === "anonymous" ? "" : readableName(attrText) ?? "",
        ageRange: age,
        organizationName: org.trim() || null,
        showOrganization: !locked && showOrg && Boolean(org.trim()),
        message,
        email: locked ? null : email.trim() || null,
        groupId,
        permissions: locked ? lockPermissions(perms) : perms,
        guardianConsentAttested: asksAttest && guardianOk,
      });
      track("submission_completed");
      nav(`/submit/success/${sub.id}`);
    } catch (e) {
      if (isNameRefusal(e)) {
        // The server decides names (its Unicode tables may be older than this browser's): its answer is shown at the
        // name question, on the step where that question is.
        setNameProblem(e.message);
        if (!nameOnPermissionStep) setStep(4);
      } else {
        setError(e instanceof Error ? e.message : "Whoops. That picture didn’t make it through. Let’s try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const nameChoice = (
    <fieldset>
      <legend>How should we name the artist in public, if we show it?</legend>
      <label className="choice">
        <input
          type="radio"
          name="attr"
          checked={attrKind === "firstName"}
          onChange={() => {
            setAttrKind("firstName");
            setNameProblem(null);
          }}
        />
        First name
      </label>
      <label className="choice">
        <input
          type="radio"
          name="attr"
          checked={attrKind === "nickname"}
          onChange={() => {
            setAttrKind("nickname");
            setNameProblem(null);
          }}
        />
        Nickname
      </label>
      <label className="choice">
        <input
          type="radio"
          name="attr"
          checked={attrKind === "anonymous"}
          onChange={() => {
            setAttrKind("anonymous");
            setNameProblem(null);
          }}
        />
        Anonymous
      </label>
      {attrKind !== "anonymous" && (
        <>
          <label htmlFor="attr">Name or nickname</label>
          <input
            id="attr"
            name="attribution"
            maxLength={80}
            value={attrText}
            onChange={(e) => {
              setAttrText(e.target.value);
              setNameProblem(null);
            }}
          />
        </>
      )}
      {nameProblem && (
        <p className="flag" role="alert">
          {nameProblem}
        </p>
      )}
    </fieldset>
  );

  return (
    <div className="wrap section">
      <p className="kicker">Refrigerator door</p>
      <h1>Send us your art</h1>
      <p>About one or two minutes on a phone. No account.</p>
      {groupLabel && <p className="fine">Sending as part of: {groupLabel}</p>}
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
                      accept={PHOTO_ACCEPT}
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
                      accept={PHOTO_ACCEPT}
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
            <label htmlFor="age">Age range (optional)</label>
            <select id="age" name="age" value={age} onChange={(e) => setAge(e.target.value as AgeRange)}>
              <option value="prefer_not">Prefer not to say</option>
              <option value="under_13">Under 13</option>
              <option value="13_17">13–17</option>
              <option value="18_plus">18+</option>
            </select>
            {locked ? (
              <p className="fine" role="note">
                {lockReason(age, role)}
              </p>
            ) : (
              nameChoice
            )}
            <label htmlFor="org">Organization or group (optional)</label>
            <input
              id="org"
              name="organization"
              maxLength={120}
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="school, community group, family…"
            />
            <label className="choice">
              <input type="checkbox" checked={showOrg} disabled={locked} onChange={(e) => setShowOrg(e.target.checked)} />
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
            <textarea id="msg" name="message" maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} />
            <p className="fine">Ideas, not rules: {MESSAGE_EXAMPLES.join(" · ")} Or whatever you want.</p>
            {locked ? (
              <p className="fine" role="note">
                {emailReason(age)}
              </p>
            ) : (
              <>
                <label htmlFor="email">Email if you want a note that we got it (optional)</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  maxLength={254}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </>
            )}
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
            {asksAttest && (
              <label className="choice">
                <input
                  type="checkbox"
                  name="guardianConsentAttested"
                  checked={guardianOk}
                  onChange={(e) => setGuardianOk(e.target.checked)}
                />
                <span>
                  <strong>{GUARDIAN_ATTESTATION_LABEL}</strong>
                </span>
              </label>
            )}
            {nameOnPermissionStep && nameChoice}
            {locked && (
              <p className="fine" role="note">
                {lockReason(age, role)}
              </p>
            )}
            {CONSENT_FIELDS.map((f) => {
              const off = locked && MINOR_LOCKED_KEYS.includes(f.key);
              return (
                <label className="choice" key={f.key}>
                  <input
                    type="checkbox"
                    name={f.key}
                    checked={off ? false : perms[f.key]}
                    disabled={off}
                    onChange={(e) => setPerms({ ...perms, [f.key]: e.target.checked })}
                  />
                  <span>
                    <strong>{f.label}</strong>
                    <br />
                    <span className="fine">{f.help}</span>
                  </span>
                </label>
              );
            })}
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
