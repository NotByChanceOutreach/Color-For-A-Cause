#!/usr/bin/env node
/**
 * npm run test:rules
 *
 * Starts the Firestore + Storage emulators under the offline demo-cfac
 * project, runs the emulator-backed rules tests (vitest.rules.config.ts),
 * and makes sure no emulator THIS RUN started is left running afterwards.
 *
 * Why a wrapper: on Windows `firebase emulators:exec` stops the Firestore
 * emulator by signalling the shell that launched java.exe, which leaves the
 * JVM orphaned and still listening on 8080 / 9150. So while the run goes, the
 * process tree under the spawned CLI is recorded (PID, creation time, command
 * line); afterwards only an emulator JVM from that recorded tree, created after
 * the CLI was spawned and still the very same process, is stopped. The CLI is
 * a root only while it is the very process spawned (its identity is recorded
 * when first seen) and never after its exit event. Each kill re-checks the
 * creation time and command line immediately before it (stopIfSame). Nothing
 * else, ever: not another project's emulator, not another agent's concurrent
 * run, not a dev server. If the first process listing fails, nothing at all is
 * stopped (scripts/emulatorProcs.mjs).
 */
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import {
  EXPECTED_CMD_ENV,
  PROJECT,
  createTracker,
  parsePosix,
  parseWindows,
  sameProcess,
  windowsStopScript,
} from "./emulatorProcs.mjs";

const PORTS = [8080, 9199, 4400, 4500, 9150, 4000];
const POLL_MS = 2000;
const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WINDOWS_LISTING =
  "Get-CimInstance Win32_Process | ForEach-Object { " +
  "$c = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; " +
  "\"$($_.ProcessId)`t$($_.ParentProcessId)`t$c`t$($_.Name)`t$($_.CommandLine)\" }";

/** Every process: pid, parent pid, creation time, name, command line. null when the listing failed. */
async function snapshot() {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LISTING], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      });
      const procs = parseWindows(stdout);
      return procs.length ? procs : null;
    }
    const { stdout } = await run("ps", ["-eo", "pid=,ppid=,etimes=,comm=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const procs = parsePosix(stdout, Date.now());
    return procs.length ? procs : null;
  } catch {
    return null;
  }
}

function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

const before = await snapshot();
if (before === null) {
  console.warn("test:rules: could not list processes before the run; no process will be stopped afterwards.");
}

const spawnedAt = Date.now();
const child = spawn(
  `firebase emulators:exec --only firestore,storage --project ${PROJECT} "vitest run --config vitest.rules.config.ts"`,
  { stdio: "inherit", shell: true },
);
const tracker = createTracker(before, child.pid, spawnedAt);

let running = true;
const watcher = (async () => {
  while (running) {
    const procs = await snapshot();
    if (running) tracker.observe(procs);
    await sleep(POLL_MS);
  }
})();

const code = await new Promise((resolve) => {
  child.on("error", (err) => {
    console.error(`Could not start the Firebase CLI: ${err.message}`);
    tracker.cliExited();
    resolve(1);
  });
  child.on("exit", (status) => {
    // From here on the CLI's PID may be handed to another process: it is never used as a root again.
    running = false;
    tracker.cliExited();
    resolve(status ?? 1);
  });
});
running = false;
await watcher;

/**
 * Stop `proc` only if its PID still names the very process recorded: identity (creation time and command line) is
 * checked again immediately before the kill. On Windows the check and the Terminate run in one PowerShell script
 * (windowsStopScript); the expected command line travels in an environment variable, never inside the script text.
 * @returns {Promise<"stopped" | "changed" | "gone" | "failed">}
 */
async function stopIfSame(proc) {
  try {
    if (process.platform === "win32") {
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsStopScript(proc)], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, [EXPECTED_CMD_ENV]: proc.cmd },
      });
      const said = stdout.trim().split(/\r?\n/).pop();
      return said === "stopped" || said === "changed" || said === "gone" ? said : "failed";
    }
    const { stdout } = await run("ps", ["-o", "pid=,ppid=,etimes=,comm=,args=", "-p", String(proc.pid)], { encoding: "utf8" });
    const fresh = parsePosix(stdout, Date.now()).find((p) => p.pid === proc.pid);
    if (!fresh) return "gone";
    if (!sameProcess(fresh, proc)) return "changed";
    process.kill(proc.pid);
    return "stopped";
  } catch {
    return "failed";
  }
}

// Give the emulators a moment to exit on their own, then stop only this run's own leftovers.
await sleep(1500);
const after = await snapshot();
tracker.observe(after);
for (const proc of tracker.toStop(after)) {
  const result = await stopIfSame(proc);
  if (result === "stopped") console.log(`test:rules: stopped leftover emulator process ${proc.pid} started by this run`);
  else if (result === "changed") console.warn(`test:rules: PID ${proc.pid} now names another process; left alone`);
}

await sleep(500);
const busy = [];
for (const port of PORTS) if (await portInUse(port)) busy.push(port);
if (busy.length) {
  console.warn(`test:rules: ports still in use after the run: ${busy.join(", ")} (not started by this run, or still closing).`);
}

process.exit(code);
