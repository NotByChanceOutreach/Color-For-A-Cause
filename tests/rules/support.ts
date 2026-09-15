import { readFileSync } from "node:fs";
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
  type TestEnvironmentConfig,
} from "@firebase/rules-unit-testing";

/** Offline emulator project. Never a real Firebase project. */
export const PROJECT_ID = "demo-cfac";

/** Every kind of caller the rules must handle. */
export const PERSONAS = [
  "anonymous",
  "signedIn",
  "REVIEWER",
  "ART_MANAGER",
  "IMPACT_MANAGER",
  "ADMIN",
] as const;
export type Persona = (typeof PERSONAS)[number];

export const EVERYONE: readonly Persona[] = PERSONAS;
export const NOBODY: readonly Persona[] = [];
export const ADMIN_ONLY: readonly Persona[] = ["ADMIN"];
/** Staff who work the review queue (read submissions + derivatives). */
export const QUEUE_STAFF: readonly Persona[] = ["REVIEWER", "ART_MANAGER", "ADMIN"];

/** Opaque ids in the real server formats (hexId("sub") etc.). */
export const SUB = "sub_0123456789abcdef0123456789abcdef";
export const OTHER_SUB = "sub_fedcba9876543210fedcba9876543210";
export const CON = "con_0123456789abcdef0123456789abcdef";
export const GRP = "grp_0123456789abcdef0123456789abcdef";
export const COL = "col_0123456789abcdef0123456789abcdef";

export function contextFor(env: RulesTestEnvironment, persona: Persona): RulesTestContext {
  switch (persona) {
    case "anonymous":
      return env.unauthenticatedContext();
    case "signedIn":
      // A real Firebase Auth user with no staff claim.
      return env.authenticatedContext("user-without-role", { email: "someone@example.org" });
    default:
      return env.authenticatedContext(`staff-${persona.toLowerCase()}`, { role: persona });
  }
}

export async function startEnv(
  emulator: "firestore" | "storage",
): Promise<RulesTestEnvironment> {
  if (!PROJECT_ID.startsWith("demo-")) throw new Error("Rules tests must use a demo- project id.");
  const hostVar = emulator === "firestore" ? "FIRESTORE_EMULATOR_HOST" : "FIREBASE_STORAGE_EMULATOR_HOST";
  if (!process.env[hostVar]) {
    throw new Error(
      `${hostVar} is not set. Run the rules tests with "npm run test:rules" so the ${emulator} emulator is started.`,
    );
  }
  const config: TestEnvironmentConfig = { projectId: PROJECT_ID };
  if (emulator === "firestore") config.firestore = { rules: readFileSync("firestore.rules", "utf8") };
  else {
    config.storage = { rules: readFileSync("storage.rules", "utf8") };
    // The Art Wall image rule reads Firestore (cross-service firestore.exists on publicGallery), so the Storage
    // tests seed documents in the Firestore emulator of the same demo project.
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('FIRESTORE_EMULATOR_HOST is not set. Run the rules tests with "npm run test:rules".');
    }
    config.firestore = { rules: readFileSync("firestore.rules", "utf8") };
  }
  return initializeTestEnvironment(config);
}

export function verdict(allowed: readonly Persona[], persona: Persona): boolean {
  return allowed.includes(persona);
}
