/**
 * Refusals the server explains to people: a callable error whose code says the message was written for them.
 * The forms use the code to tell a refusal of ONE piece (fix that piece and send it again; the rest of a batch can
 * still go) from a failure of the connection or of the server.
 */
export class ServerRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServerRefusal";
    this.code = code;
  }
}

/**
 * The server's refusal of a name with nothing readable in it. Mirrors NAME_REQUIRED in functions/src/validation.ts
 * (tests/functions/textCore.test.ts fails if they differ). The forms check names with the same code first, but the
 * browser's Unicode tables can be newer than the server's, and then only the server's answer counts.
 */
export const NAME_REQUIRED = "Please type a first name or nickname we can read, or choose Anonymous.";

/** The server refused this one piece for something in it (its text, its choices): the rest of a batch can go. */
export function isPieceRefusal(err: unknown): err is ServerRefusal {
  return err instanceof ServerRefusal && (err.code === "invalid-argument" || err.code === "failed-precondition");
}

/**
 * A callable error as people should see it. Server messages for the codes in `passThrough` are written for people
 * and pass through (without Firebase's "Firebase:" prefix and "(functions/…)" suffix); everything else becomes
 * `fallback`. With `keepCode`, a message that passes through is a ServerRefusal carrying the bare code, so a form can
 * tell a refusal of one piece (flag it, send the rest) from a failed connection.
 */
export function explainServerError(err: unknown, fallback: string, passThrough: RegExp, keepCode = false): Error {
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  const msg = (err instanceof Error ? err.message : "")
    .replace(/^Firebase:\s*/i, "")
    .replace(/\s*\([a-z-]+\/[a-z-]+\)\.?$/i, "")
    .trim();
  if (passThrough.test(code) && msg) return keepCode ? new ServerRefusal(code.replace(/^functions\//, ""), msg) : new Error(msg);
  return new Error(fallback);
}

/** The server could not read the name. */
export function isNameRefusal(err: unknown): err is ServerRefusal {
  return err instanceof ServerRefusal && err.code === "invalid-argument" && err.message === NAME_REQUIRED;
}
