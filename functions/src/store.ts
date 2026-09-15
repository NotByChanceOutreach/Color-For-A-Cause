/**
 * The minimal slice of Firestore the business logic needs. index.ts adapts the Admin SDK to it;
 * tests use an in-memory fake. Keeping it this small is what lets C3/C4/C7/C8 be unit-tested.
 */
export type Data = Record<string, unknown>;

export interface DocRef {
  readonly path: string;
}

export interface Snap {
  readonly exists: boolean;
  data(): Data | undefined;
}

/** Firestore transaction semantics: every read must happen before the first write. */
export interface Tx {
  get(ref: DocRef): Promise<Snap>;
  set(ref: DocRef, data: Data, options?: { merge?: boolean }): unknown;
  update(ref: DocRef, data: Data): unknown;
  create(ref: DocRef, data: Data): unknown;
  delete(ref: DocRef): unknown;
}

export interface Db {
  doc(path: string): DocRef;
  /** A new document reference with an auto id in `collection`. */
  newDoc(collection: string): DocRef;
  get(ref: DocRef): Promise<Snap>;
  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** Firestore write sentinels (FieldValue.*). */
export interface Ops {
  increment(n: number): unknown;
  serverTimestamp(): unknown;
  deleteField(): unknown;
}

/** Firestore Timestamp, Date, or epoch millis to epoch millis. */
export function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v && typeof v === "object") {
    const o = v as { toMillis?: unknown; seconds?: unknown };
    if (typeof o.toMillis === "function") return (o.toMillis as () => number).call(v);
    if (typeof o.seconds === "number") return o.seconds * 1000;
  }
  return null;
}

export type AuditEntry = { actor: string; action: string; target: string; detail: string };

/** Append-only audit record, written inside the caller's transaction. */
export function audit(tx: Tx, db: Db, ops: Ops, entry: AuditEntry): void {
  tx.create(db.newDoc("auditLogs"), { at: ops.serverTimestamp(), ...entry, detail: entry.detail.slice(0, 2000) });
}
