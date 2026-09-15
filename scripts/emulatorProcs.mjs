/**
 * Which processes `npm run test:rules` (scripts/test-rules.mjs) may stop after its run. Pure functions, so
 * tests/testRulesScript.test.ts can check them without starting anything.
 *
 * The rule: ONLY an emulator JVM that this run started itself, which means ALL of
 *   - it was recorded in this run's own process tree WHILE the run went: a child of the Firebase CLI process the run
 *     spawned, or of a process already recorded that way, found through a parent that was alive, verified and older
 *     than the child at that moment. (The tree is recorded during the run because on Windows the Firestore JVM
 *     outlives the shell that launched it and can no longer be traced from the CLI afterwards.)
 *   - it was created after the run spawned its CLI (Win32_Process.CreationDate, or ps etimes);
 *   - it is still the very process that was recorded: same PID, creation time and command line. A recorded PID that
 *     is gone from a listing (or now names another process) is forgotten for good: it is never again a parent nor a
 *     target, so a reused PID never counts;
 *   - it was not running before the run.
 * The CLI itself is a root only while it is provably the process the run spawned: its identity (PID, creation time,
 * command line) is recorded the first time it is seen (created at the spawn, within CLI_START_WINDOW_MS), every
 * later listing must show that very process, and once it is missing, changed, or its `exit` event has fired
 * (cliExited) it is never a root again. So a PID of the CLI reused after it exited never leads to anything.
 * Just before a kill, the process's creation time and command line are checked once more (windowsStopScript does the
 * check and the Terminate in one PowerShell script), so a PID reused after the final listing is left alone.
 * The project name is never a reason on its own, and if the first process listing fails nothing is stopped at all.
 * So another project's emulator (next-chance-navigator's demo-next-chance on port 18080), a Vite dev server, another
 * agent's concurrent `npm run test:rules`, or anything already running are never touched.
 */

export const PROJECT = "demo-cfac";
export const EMULATOR_JAR = /cloud-firestore-emulator|cloud-storage-rules-runtime|cloud-storage-emulator/i;
const JVM = /(^|[\\/\s"])java(w)?(\.exe)?("|\s|$)/i;
/** Creation times from ps are whole seconds; two listings of one process may differ by that much. */
export const CREATED_SLACK_MS = 2000;
/**
 * spawn() creates the CLI's process synchronously, so its creation time is within milliseconds of the spawn
 * (measured: 2-3 ms). A process at the CLI's PID created later than this is a reuse of the PID, never our CLI.
 */
export const CLI_START_WINDOW_MS = 10_000;
/** Environment variable that carries the expected command line to windowsStopScript (never put in the script). */
export const EXPECTED_CMD_ENV = "CFAC_TEST_RULES_EXPECTED_CMDLINE";

/**
 * PowerShell that stops `proc` only if its PID still names the very process recorded: the CreationDate (Unix ms)
 * and the command line (read from $env:CFAC_TEST_RULES_EXPECTED_CMDLINE) are checked immediately before Terminate,
 * in the same script. Prints "stopped", "changed", "gone" or "failed".
 * @param {Proc} proc
 */
export function windowsStopScript(proc) {
  if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0 || !Number.isSafeInteger(proc.created) || proc.created <= 0) {
    throw new Error("windowsStopScript: not a recorded process");
  }
  return (
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${proc.pid}"; ` +
    "if (-not $p) { 'gone' } " +
    "elseif (-not $p.CreationDate) { 'changed' } " +
    `elseif (([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() -ne ${proc.created}) { 'changed' } ` +
    `elseif ("$($p.CommandLine)".Trim() -cne $env:${EXPECTED_CMD_ENV}) { 'changed' } ` +
    "else { $r = Invoke-CimMethod -InputObject $p -MethodName Terminate; if ($r.ReturnValue -eq 0) { 'stopped' } else { 'failed' } }"
  );
}

/** @typedef {{ pid: number, ppid: number, created: number, name: string, cmd: string }} Proc */

/**
 * Win32_Process lines: "pid<TAB>ppid<TAB>creation time (Unix ms)<TAB>name<TAB>command line".
 * @param {string} out
 * @returns {Proc[]}
 */
export function parseWindows(out) {
  return out
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter(([pid, ppid, created]) => [pid, ppid, created].every((v) => /^\d+$/.test(v?.trim() ?? "")))
    .map(([pid, ppid, created, name = "", ...cmd]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      created: Number(created),
      name: name.trim(),
      cmd: cmd.join("\t").trim(),
    }));
}

/**
 * `ps -eo pid=,ppid=,etimes=,comm=,args=` lines; `nowMs` is when the listing was taken.
 * @param {string} out
 * @param {number} nowMs
 * @returns {Proc[]}
 */
export function parsePosix(out, nowMs) {
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), created: nowMs - Number(m[3]) * 1000, name: m[4], cmd: m[5].trim() }));
}

/**
 * The same process in two listings: same PID, same command line, creation times within CREATED_SLACK_MS.
 * @param {Proc} a
 * @param {Proc} b
 */
export function sameProcess(a, b) {
  return a.pid === b.pid && a.cmd === b.cmd && Math.abs(a.created - b.created) <= CREATED_SLACK_MS;
}

/** @param {Proc} p */
export function isEmulatorJvm(p) {
  return (JVM.test(p.name) || JVM.test(p.cmd)) && EMULATOR_JAR.test(p.cmd);
}

/**
 * Every process in `procs` descended from one of `roots` (the roots themselves excluded), by parent PID only.
 * @param {Proc[]} procs
 * @param {number[]} roots
 * @returns {Map<number, Proc>}
 */
export function descendants(procs, roots) {
  const children = new Map();
  for (const p of procs) {
    if (p.pid === p.ppid) continue;
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const found = new Map();
  const visited = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      found.set(child.pid, child);
      queue.push(child.pid);
    }
  }
  return found;
}

/**
 * This run's process tree, recorded listing by listing.
 * @param {Proc[] | null} before the listing taken before the CLI was spawned; null when it failed (nothing is ever
 *   stopped then)
 * @param {number | undefined} cliPid the PID of the spawned CLI process
 * @param {number} spawnedAt Unix ms, taken just before the CLI was spawned
 */
export function createTracker(before, cliPid, spawnedAt) {
  const disabled = before === null || typeof cliPid !== "number";
  const earlier = before ?? [];
  /** @type {Map<number, Proc>} pid -> the process as recorded */
  const seen = new Map();
  /** @type {Set<number>} recorded once, then gone or replaced: never trusted again */
  const forgotten = new Set();
  /** @param {Proc} p */
  const ranBefore = (p) => earlier.some((b) => sameProcess(b, p));
  /** @type {Proc | null} the CLI as first seen (PID, creation time, command line) */
  let cliRecord = null;
  /** False once the CLI was missing from a listing, changed, or exited: from then on it is never a root. */
  let cliTrusted = !disabled;

  function forgetCli() {
    cliTrusted = false;
    forgotten.add(/** @type {number} */ (cliPid));
  }

  /**
   * The CLI as a root for this listing, or null. The first time it is seen its identity is recorded (it must have
   * been created at the spawn: not before it, not more than CLI_START_WINDOW_MS after it, not running before);
   * afterwards the listing must show that very process (sameProcess). Missing or changed once: forgotten for good.
   * @param {Map<number, Proc>} live
   */
  function cliRoot(live) {
    if (!cliTrusted) return null;
    const now = live.get(/** @type {number} */ (cliPid));
    if (!now) {
      forgetCli();
      return null;
    }
    if (cliRecord === null) {
      if (now.created < spawnedAt || now.created > spawnedAt + CLI_START_WINDOW_MS || ranBefore(now)) {
        forgetCli();
        return null;
      }
      cliRecord = now;
      return now;
    }
    if (!sameProcess(now, cliRecord)) {
      forgetCli();
      return null;
    }
    return now;
  }

  /** Forget every recorded PID that is gone from `procs` or now names another process. */
  function prune(procs) {
    const live = new Map(procs.map((p) => [p.pid, p]));
    for (const [pid, rec] of [...seen]) {
      const now = live.get(pid);
      if (!now || !sameProcess(now, rec)) {
        seen.delete(pid);
        forgotten.add(pid);
      }
    }
    return live;
  }

  return {
    disabled,
    /** @returns {ReadonlyMap<number, Proc>} */
    recorded: () => seen,
    /** The CLI's recorded identity while it is still trusted as a root, else null. */
    cli: () => (cliTrusted ? cliRecord : null),
    /** The CLI's `exit` event fired: its PID may be reused from now on, so it is never a root again. */
    cliExited() {
      if (!disabled) forgetCli();
    },
    /**
     * One listing taken while the run goes (and the final one). A failed listing (null) records nothing.
     * @param {Proc[] | null} procs
     */
    observe(procs) {
      if (disabled || procs === null) return;
      const live = prune(procs);
      /** @type {Proc[]} */
      const queue = [];
      const cli = cliRoot(live);
      if (cli) queue.push(cli);
      queue.push(...seen.values());
      const children = new Map();
      for (const p of procs) {
        if (p.pid === p.ppid) continue;
        if (!children.has(p.ppid)) children.set(p.ppid, []);
        children.get(p.ppid).push(p);
      }
      const visited = new Set(queue.map((p) => p.pid));
      while (queue.length) {
        const parent = /** @type {Proc} */ (queue.shift());
        for (const child of children.get(parent.pid) ?? []) {
          if (visited.has(child.pid) || forgotten.has(child.pid)) continue;
          // A real child is younger than its parent and than the spawn; an older process whose parent PID merely
          // matches (the PID of a parent long gone, reused) is not ours.
          if (child.created < parent.created || child.created < spawnedAt || ranBefore(child)) continue;
          visited.add(child.pid);
          seen.set(child.pid, child);
          queue.push(child);
        }
      }
    },
    /**
     * The emulator JVMs this run may stop, judged on the final listing (after observe() of that same listing).
     * @param {Proc[] | null} procs
     * @returns {Proc[]}
     */
    toStop(procs) {
      if (disabled || procs === null) return [];
      prune(procs);
      return procs.filter((p) => {
        const rec = seen.get(p.pid);
        return rec !== undefined && sameProcess(rec, p) && isEmulatorJvm(p) && p.created >= spawnedAt && !ranBefore(p);
      });
    },
  };
}
