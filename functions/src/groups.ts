/**
 * createGroup / getGroup. Groups are only reachable through these callables (no client list or read).
 * The internal document id (grp_...) never leaves the server: callers only ever see the public code.
 *
 * Labels are public to anyone holding the code (the submit form shows "Sending as part of: <label>"). createGroup
 * stores a label cleaned like every other public text (validation.ts), and getGroup cleans the stored label again
 * before returning it, because labels saved before these rules (9b2fc57 kept them raw) may hold invisible or blank
 * characters. Nothing readable left: the fallback "Art day".
 */
import { TEXT_LIMITS } from "./constants";
import { toMillis, type Data, type Db, type Ops } from "./store";
import { capText } from "./textCore";
import { newGroupPublicId, newId } from "./upload";
import { GROUP_LABEL_FALLBACK, cleanStoredText, hasReadableText, parseCreateGroupRequest, parseGetGroupRequest } from "./validation";

export type GroupView = { publicId: string; label: string; createdAt: string };

export interface GroupDeps {
  db: Db;
  ops: Ops;
  now(): number;
  rateLimit(): Promise<void>;
  /** Indexed equality lookup, never a scan. */
  findByPublicId(publicId: string): Promise<Data | null>;
}

/** A stored label as the public may see it: cleaned again, capped, or the fallback when nothing readable is left. */
export function readableGroupLabel(stored: unknown): string {
  const label = capText(cleanStoredText(stored, false), TEXT_LIMITS.groupLabel, false);
  return hasReadableText(label) ? label : GROUP_LABEL_FALLBACK;
}

export async function createGroup(deps: GroupDeps, raw: unknown): Promise<GroupView> {
  const { label } = parseCreateGroupRequest(raw);
  await deps.rateLimit();
  const id = newId("grp");
  const publicId = newGroupPublicId();
  await deps.db.runTransaction(async (tx) => {
    tx.create(deps.db.doc(`groups/${id}`), { id, publicId, label, createdAt: deps.ops.serverTimestamp() });
  });
  return { publicId, label, createdAt: new Date(deps.now()).toISOString() };
}

export async function getGroup(deps: GroupDeps, raw: unknown): Promise<GroupView | null> {
  const { publicId } = parseGetGroupRequest(raw);
  const row = await deps.findByPublicId(publicId);
  if (!row) return null;
  const created = toMillis(row.createdAt);
  return {
    publicId,
    label: readableGroupLabel(row.label),
    createdAt: new Date(created ?? deps.now()).toISOString(),
  };
}
