export type Proc = { pid: number; ppid: number; created: number; name: string; cmd: string };

export type Tracker = {
  readonly disabled: boolean;
  recorded(): ReadonlyMap<number, Proc>;
  cli(): Proc | null;
  cliExited(): void;
  observe(procs: Proc[] | null): void;
  toStop(procs: Proc[] | null): Proc[];
};

export const PROJECT: string;
export const EMULATOR_JAR: RegExp;
export const CREATED_SLACK_MS: number;
export const CLI_START_WINDOW_MS: number;
export const EXPECTED_CMD_ENV: string;
export function windowsStopScript(proc: Proc): string;
export function parseWindows(out: string): Proc[];
export function parsePosix(out: string, nowMs: number): Proc[];
export function sameProcess(a: Proc, b: Proc): boolean;
export function isEmulatorJvm(p: Proc): boolean;
export function descendants(procs: Proc[], roots: number[]): Map<number, Proc>;
export function createTracker(before: Proc[] | null, cliPid: number | undefined, spawnedAt: number): Tracker;
