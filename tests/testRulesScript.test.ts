import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLI_START_WINDOW_MS,
  CREATED_SLACK_MS,
  EXPECTED_CMD_ENV,
  createTracker,
  descendants,
  parsePosix,
  parseWindows,
  sameProcess,
  windowsStopScript,
  type Proc,
} from "../scripts/emulatorProcs.mjs";

const FIRESTORE_JAR = "C:\\Users\\x\\.cache\\firebase\\emulators\\cloud-firestore-emulator-v1.21.0.jar";
const RULES_JAR = "C:\\Users\\x\\.cache\\firebase\\emulators\\cloud-storage-rules-runtime-v1.1.3.jar";
const java = (jar: string, project?: string, port = 8080) =>
  `"C:\\Program Files\\Java\\jdk-23\\bin\\java.exe" -jar ${jar} --host 127.0.0.1 --port ${port}${project ? ` --project_id ${project}` : ""}`;

/** The moment our run spawned its CLI; everything our run starts is younger. */
const SPAWNED = 1_800_000_000_000;
const CLI = 500;

const OTHER_PROJECT: Proc = { pid: 37156, ppid: 79196, created: SPAWNED - 7 * 86_400_000, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-next-chance", 18080) };
const DEV_SERVER: Proc = { pid: 130880, ppid: 1, created: SPAWNED - 3_600_000, name: "node.exe", cmd: "node vite --port 5173" };
const SYSTEM: Proc = { pid: 4, ppid: 0, created: 0, name: "System", cmd: "" };
/** What was running before our run. */
const BEFORE: Proc[] = [SYSTEM, OTHER_PROJECT, DEV_SERVER];

const cli: Proc = { pid: CLI, ppid: 100, created: SPAWNED + 5, name: "cmd.exe", cmd: "cmd /c firebase emulators:exec ..." };
const node: Proc = { pid: 501, ppid: CLI, created: SPAWNED + 40, name: "node.exe", cmd: "node firebase emulators:exec --only firestore,storage --project demo-cfac" };
const shell: Proc = { pid: 502, ppid: 501, created: SPAWNED + 900, name: "cmd.exe", cmd: "cmd /c java -jar firestore" };
const firestoreJvm: Proc = { pid: 503, ppid: 502, created: SPAWNED + 950, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-cfac") };
const rulesJvm: Proc = { pid: 504, ppid: 501, created: SPAWNED + 1200, name: "java.exe", cmd: java(RULES_JAR) };
/** Our whole tree while the run goes. */
const OURS = [cli, node, shell, firestoreJvm, rulesJvm];

const pids = (ps: Proc[]) => ps.map((p) => p.pid).sort((a, b) => a - b);

describe("npm run test:rules stops only emulators it started itself", () => {
  it("records the run's own tree while it goes, and stops its JVMs even after the CLI and the shells exited", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    t.observe([...BEFORE, ...OURS]);
    expect(pids([...t.recorded().values()])).toEqual([501, 502, 503, 504]);
    // The run ends: the CLI, node and the shell are gone; the JVMs are orphans (Windows) and still running.
    const after = [...BEFORE, firestoreJvm, rulesJvm];
    t.observe(after);
    expect(pids(t.toStop(after))).toEqual([503, 504]);
  });

  it("never stops another project's emulator, a dev server, or anything that ran before the run", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    t.observe([...BEFORE, ...OURS]);
    const stop = pids(t.toStop([...BEFORE, ...OURS]));
    expect(stop).not.toContain(37156);
    expect(stop).not.toContain(130880);
    expect(stop).toEqual([503, 504]);
  });

  it("case A: the first process listing failed, so nothing is stopped, not even this run's own JVMs", () => {
    const t = createTracker(null, CLI, SPAWNED);
    expect(t.disabled).toBe(true);
    t.observe([...BEFORE, ...OURS]);
    const leftoverOfOtherSession: Proc = { pid: 800, ppid: 1, created: SPAWNED - 60_000, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-cfac") };
    expect(t.toStop([...BEFORE, ...OURS, leftoverOfOtherSession])).toEqual([]);
  });

  it("case B: another run's demo-cfac emulator started during our run is not ours (not in our tree; the project name is no reason)", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    const otherCli: Proc = { pid: 890, ppid: 100, created: SPAWNED + 2000, name: "cmd.exe", cmd: "cmd /c firebase emulators:exec ..." };
    const otherJvm: Proc = { pid: 900, ppid: 890, created: SPAWNED + 2500, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-cfac") };
    t.observe([...BEFORE, ...OURS, otherCli, otherJvm]);
    // Our CLI has exited; the other run's CLI exited too, orphaning its JVM, just as our final listing is taken.
    const after = [...BEFORE, firestoreJvm, rulesJvm, { ...otherJvm }];
    t.observe(after);
    expect(pids(t.toStop(after))).toEqual([503, 504]);
    // Even a demo-cfac JVM created after our spawn with no link to our tree stays.
    const stray: Proc = { pid: 901, ppid: 1, created: SPAWNED + 3000, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-cfac") };
    t.observe([...after, stray]);
    expect(pids(t.toStop([...after, stray]))).not.toContain(901);
  });

  it("case C: a recorded PID that exited is never trusted again, even when another project's launcher reuses it", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    t.observe([...BEFORE, ...OURS]);
    // Our shell 502 exits (its JVM 503 lives on). Windows hands PID 502 to another project's launcher, which starts
    // a demo-next-chance emulator (950) and exits in turn, the same Windows behaviour the script works around.
    t.observe([...BEFORE, cli, node, firestoreJvm, rulesJvm]);
    const reused: Proc = { ...shell, created: SPAWNED + 60_000, cmd: "cmd /c java -jar firestore" }; // same command line
    const theirJvm: Proc = { pid: 950, ppid: 502, created: SPAWNED + 61_000, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-next-chance", 18081) };
    t.observe([...BEFORE, cli, node, firestoreJvm, rulesJvm, reused, theirJvm]);
    const after = [...BEFORE, firestoreJvm, rulesJvm, theirJvm];
    t.observe(after);
    expect(pids(t.toStop(after))).toEqual([503, 504]);
    expect(t.recorded().has(950)).toBe(false);
  });

  it("case C: a recorded JVM whose PID now names another process (same command line, other creation time) is not stopped", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    t.observe([...BEFORE, ...OURS]);
    const impostor: Proc = { ...firestoreJvm, created: firestoreJvm.created + CREATED_SLACK_MS + 5000 };
    const after = [...BEFORE, impostor, rulesJvm];
    t.observe(after);
    expect(pids(t.toStop(after))).toEqual([504]);
    // ...and it stays forgotten, even if the original identity were to show up again.
    expect(pids(t.toStop([...BEFORE, firestoreJvm, rulesJvm]))).toEqual([504]);
  });

  it("an older process whose parent PID merely matches one of ours (a reused parent PID) is not ours", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    const older: Proc = { pid: 777, ppid: 501, created: SPAWNED - 5000, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-cfac") };
    t.observe([...BEFORE, ...OURS, older]);
    expect(t.recorded().has(777)).toBe(false);
    expect(pids(t.toStop([...BEFORE, ...OURS, older]))).toEqual([503, 504]);
  });

  it("only JVMs of the emulator jars, never the CLI, node or a shell of the run", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    t.observe([...BEFORE, ...OURS]);
    expect(pids(t.toStop([...BEFORE, ...OURS]))).toEqual([503, 504]);
  });

  it("a failed listing in the middle records nothing and trusts nothing new", () => {
    const t = createTracker(BEFORE, CLI, SPAWNED);
    t.observe(null);
    expect(t.recorded().size).toBe(0);
    expect(t.toStop(null)).toEqual([]);
  });

  it("identity is PID, command line and creation time", () => {
    expect(sameProcess(firestoreJvm, { ...firestoreJvm })).toBe(true);
    expect(sameProcess(firestoreJvm, { ...firestoreJvm, cmd: java(FIRESTORE_JAR, "demo-next-chance") })).toBe(false);
    expect(sameProcess(firestoreJvm, { ...firestoreJvm, created: firestoreJvm.created + 60_000 })).toBe(false);
  });

  it("descendants() still walks a tree by parent PID", () => {
    expect([...descendants([...BEFORE, ...OURS], [CLI]).keys()].sort()).toEqual([501, 502, 503, 504]);
  });

  it("parses Windows and POSIX process listings, creation times included", () => {
    expect(parseWindows(`12\t4\t1800000000123\tjava.exe\t${java(RULES_JAR)}\r\nnoise\r\n13\t4\t\tjava.exe\tx\r\n`)).toEqual([
      { pid: 12, ppid: 4, created: 1800000000123, name: "java.exe", cmd: java(RULES_JAR) },
    ]);
    expect(parsePosix("  12     4    30 java  /usr/bin/java -jar cloud-storage-rules-runtime.jar\n", SPAWNED)).toEqual([
      { pid: 12, ppid: 4, created: SPAWNED - 30_000, name: "java", cmd: "/usr/bin/java -jar cloud-storage-rules-runtime.jar" },
    ]);
  });

  describe("round 5: the CLI's own PID reused after it exited", () => {
    /** Another session's launcher that got our CLI's PID after our CLI exited, and the emulator it starts. */
    const reusedCli: Proc = { pid: CLI, ppid: 7000, created: SPAWNED + 32_000, name: "cmd.exe", cmd: "cmd /c java -jar firestore" };
    const theirJvm: Proc = { pid: 960, ppid: CLI, created: SPAWNED + 33_000, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-next-chance", 18081) };
    const finalListing = [...BEFORE, firestoreJvm, rulesJvm, reusedCli, theirJvm];

    it("after the exit event the CLI is never a root: nothing of the other process is stopped", () => {
      const t = createTracker(BEFORE, CLI, SPAWNED);
      t.observe([...BEFORE, ...OURS]);
      expect(t.cli()).toEqual(cli);
      t.cliExited();
      expect(t.cli()).toBeNull();
      t.observe(finalListing);
      expect(pids(t.toStop(finalListing))).toEqual([503, 504]);
      expect(t.recorded().has(960)).toBe(false);
    });

    it("even without the exit event, the recorded identity rejects the reused PID (other creation time and command line)", () => {
      const t = createTracker(BEFORE, CLI, SPAWNED);
      t.observe([...BEFORE, ...OURS]);
      t.observe(finalListing);
      expect(t.cli()).toBeNull();
      expect(pids(t.toStop(finalListing))).toEqual([503, 504]);
      expect(t.recorded().has(960)).toBe(false);
    });

    it("every listing during the run failed: the reused PID is not taken for our CLI, so nothing is stopped", () => {
      for (const exited of [true, false]) {
        const t = createTracker(BEFORE, CLI, SPAWNED);
        t.observe(null);
        t.observe(null);
        if (exited) t.cliExited();
        t.observe(finalListing);
        expect(t.toStop(finalListing)).toEqual([]);
      }
    });

    it("a CLI that exited within seconds, its PID reused inside the start window, is still never a root after the exit event", () => {
      const quickReuse: Proc = { ...reusedCli, created: SPAWNED + 3000 };
      const quickJvm: Proc = { ...theirJvm, created: SPAWNED + 3500 };
      const listing = [...BEFORE, quickReuse, quickJvm];
      const t = createTracker(BEFORE, CLI, SPAWNED);
      t.observe(null); // every listing while the run went failed
      t.cliExited();
      t.observe(listing);
      expect(t.cli()).toBeNull();
      expect(t.toStop(listing)).toEqual([]);
    });

    it("once the CLI is missing from a listing it is forgotten, even if a process with its very identity shows up again", () => {
      const t = createTracker(BEFORE, CLI, SPAWNED);
      t.observe([...BEFORE, ...OURS]);
      t.observe([...BEFORE, node, shell, firestoreJvm, rulesJvm]); // the CLI is gone
      const lateJvm: Proc = { pid: 970, ppid: CLI, created: SPAWNED + 40_000, name: "java.exe", cmd: java(FIRESTORE_JAR, "demo-cfac", 8081) };
      const listing = [...BEFORE, cli, node, shell, firestoreJvm, rulesJvm, lateJvm];
      t.observe(listing);
      expect(t.recorded().has(970)).toBe(false);
      expect(pids(t.toStop(listing))).toEqual([503, 504]);
    });

    it("a PID of the CLI that changed while the run goes is forgotten at once, and its children are not ours", () => {
      const t = createTracker(BEFORE, CLI, SPAWNED);
      t.observe([...BEFORE, ...OURS]);
      const listing = [...BEFORE, node, shell, firestoreJvm, rulesJvm, reusedCli, theirJvm];
      t.observe(listing);
      expect(t.cli()).toBeNull();
      expect(pids(t.toStop(listing))).toEqual([503, 504]);
    });

    it("a process at the CLI's PID created well after the spawn is never recorded as the CLI", () => {
      const t = createTracker(BEFORE, CLI, SPAWNED);
      const late: Proc = { ...cli, created: SPAWNED + CLI_START_WINDOW_MS + 1 };
      t.observe([...BEFORE, late, { ...node, created: late.created + 10 }]);
      expect(t.cli()).toBeNull();
      expect(t.recorded().size).toBe(0);
    });

    it("the kill re-checks creation time and command line right before Terminate, in one PowerShell script", () => {
      const script = windowsStopScript(firestoreJvm);
      expect(script).toContain(`ProcessId = ${firestoreJvm.pid}`);
      expect(script).toContain("CreationDate");
      expect(script).toContain(`-ne ${firestoreJvm.created}`);
      expect(script).toContain(`$env:${EXPECTED_CMD_ENV}`);
      expect(script).toMatch(/-cne \$env:/);
      expect(script.indexOf("-cne")).toBeLessThan(script.indexOf("Terminate"));
      // The command line is never put inside the script text.
      expect(script).not.toContain(firestoreJvm.cmd);
      expect(() => windowsStopScript({ ...firestoreJvm, pid: Number.NaN })).toThrow();
      expect(() => windowsStopScript({ ...firestoreJvm, created: 0 })).toThrow();
      const src = readFileSync("scripts/test-rules.mjs", "utf8");
      expect(src).toMatch(/windowsStopScript\(proc\)/);
      expect(src).toMatch(/\[EXPECTED_CMD_ENV\]: proc\.cmd/);
      expect(src).toMatch(/child\.on\("exit", \(status\) => \{[\s\S]*?tracker\.cliExited\(\);/);
      expect(src).toMatch(/await stopIfSame\(proc\)/);
      // The only bare kill is on POSIX, after a fresh `ps -p` shows the same process.
      expect(src.match(/process\.kill\(/g)).toHaveLength(1);
      expect(src).toMatch(/if \(!sameProcess\(fresh, proc\)\) return "changed";\s*process\.kill\(proc\.pid\);/);
    });
  });

  it("the script records the tree with creation times, stops nothing when the first listing fails, and uses these rules only", () => {
    const src = readFileSync("scripts/test-rules.mjs", "utf8");
    expect(src).toMatch(/const before = await snapshot\(\);/);
    expect(src).toMatch(/const spawnedAt = Date\.now\(\);\s*const child = spawn\(/);
    expect(src).toMatch(/createTracker\(before, child\.pid, spawnedAt\)/);
    expect(src).toMatch(/tracker\.toStop\(after\)/);
    expect(src).toMatch(/CreationDate/);
    expect(src).toMatch(/return null;/);
    // No other way to pick a process: no project-name match, no "new since before" rule.
    expect(src).not.toMatch(/OWN_PROJECT|leftoversToStop|trustedRoots|before\.has\(/);
    const lib = readFileSync("scripts/emulatorProcs.mjs", "utf8");
    expect(lib).not.toMatch(/OWN_PROJECT/);
  });
});
