import { spawn, type ChildProcess } from "node:child_process";

/*
 * A long-lived Python process that runs short scripts for us. Starting Python and importing the accessibility
 * library cost about 80 ms of the ~150 ms an AT-SPI query took, and every numbered action pays it. The worker
 * keeps the interpreter and its imported modules, and runs each script with `-c` semantics (sys.argv, stdout
 * captured, SystemExit honoured), so the existing scripts run unchanged.
 *
 * Safety net: one request at a time; a request that exceeds its timeout kills the worker; a worker that dies is
 * restarted, and after three deaths in a minute it is turned off and callers use the per-call process again.
 */

const WORKER = `
import sys, os, json, io, traceback
proto = os.fdopen(os.dup(1), "w", buffering=1)
compiled = {}
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    rid = req.get("id"); code = req.get("script", ""); argv = req.get("argv", [])
    out = io.StringIO(); old_out, old_argv = sys.stdout, sys.argv
    sys.stdout = out; sys.argv = ["-c"] + list(argv)
    exit_code = 0
    try:
        if code not in compiled:
            compiled[code] = compile(code, "<script>", "exec")
        exec(compiled[code], {"__name__": "__main__"})
    except SystemExit as stop:
        exit_code = stop.code if isinstance(stop.code, int) else (0 if stop.code is None else 1)
    except BaseException:
        exit_code = 1
        traceback.print_exc(file=sys.stderr)
    finally:
        sys.stdout, sys.argv = old_out, old_argv
    proto.write(json.dumps({"id": rid, "exitCode": exit_code, "stdout": out.getvalue()}) + "\\n")
    proto.flush()
`;

export interface PyResult { exitCode: number; stdout: string }

export class PythonWorker {
  #child: ChildProcess | undefined;
  #buffer = "";
  #next = 1;
  #pending: { id: number; resolve: (value: PyResult | undefined) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #deaths: number[] = [];
  #disabled = false;

  constructor(private readonly python: string, private readonly cwd?: string) {}

  get disabled(): boolean { return this.#disabled; }

  /** Runs the script. Undefined means the worker could not run it (the caller uses a per-call process instead). */
  run(script: string, argv: string[], timeoutMs: number): Promise<PyResult | undefined> {
    const task = this.#queue.then(() => this.#runOne(script, argv, timeoutMs));
    this.#queue = task.catch(() => undefined);
    return task;
  }

  close(): void {
    this.#kill();
  }

  async #runOne(script: string, argv: string[], timeoutMs: number): Promise<PyResult | undefined> {
    if (this.#disabled) return undefined;
    if (this.#child === undefined && !this.#start()) return undefined;
    const child = this.#child!;
    const id = this.#next++;
    return await new Promise<PyResult | undefined>((resolve) => {
      const timer = setTimeout(() => {
        // A hung query must not block the next one: drop the worker and report a timeout like a killed process.
        this.#pending = undefined;
        this.#kill();
        resolve({ exitCode: 124, stdout: "" });
      }, timeoutMs);
      this.#pending = { id, resolve, timer };
      child.stdin!.write(`${JSON.stringify({ id, script, argv })}\n`, (error) => {
        if (error !== null && error !== undefined && this.#pending?.id === id) { clearTimeout(timer); this.#pending = undefined; resolve(undefined); }
      });
    });
  }

  #start(): boolean {
    try {
      const child = spawn(this.python, ["-u", "-c", WORKER], { stdio: ["pipe", "pipe", "ignore"], ...(this.cwd === undefined ? {} : { cwd: this.cwd }) });
      this.#buffer = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => this.#receive(chunk));
      child.on("error", () => this.#died(child));
      child.on("exit", () => this.#died(child));
      child.stdin!.on("error", () => undefined);
      child.unref();
      (child.stdin as unknown as { unref?: () => void }).unref?.();
      (child.stdout as unknown as { unref?: () => void }).unref?.();
      this.#child = child;
      return true;
    } catch {
      this.#disabled = true;
      return false;
    }
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      try {
        const reply = JSON.parse(line) as { id: number; exitCode: number; stdout: string };
        if (this.#pending?.id === reply.id) {
          clearTimeout(this.#pending.timer);
          const { resolve } = this.#pending;
          this.#pending = undefined;
          resolve({ exitCode: reply.exitCode, stdout: reply.stdout });
        }
      } catch {
        /* not a reply */
      }
    }
  }

  #died(child: ChildProcess): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    const now = Date.now();
    this.#deaths = [...this.#deaths.filter((time) => now - time < 60_000), now];
    if (this.#deaths.length >= 3) this.#disabled = true;
    if (this.#pending !== undefined) {
      clearTimeout(this.#pending.timer);
      const { resolve } = this.#pending;
      this.#pending = undefined;
      resolve(undefined);
    }
  }

  #kill(): void {
    const child = this.#child;
    this.#child = undefined;
    if (child !== undefined) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

const WORKERS = new Map<string, PythonWorker>();

/** One shared worker per Python and display, so a nested display never talks to the real desktop's worker. */
export function pythonWorkerFor(python: string, cwd?: string): PythonWorker {
  const key = `${python}\0${process.env.DISPLAY ?? ""}\0${process.env.DBUS_SESSION_BUS_ADDRESS ?? ""}\0${cwd ?? ""}`;
  let worker = WORKERS.get(key);
  if (worker === undefined) { worker = new PythonWorker(python, cwd); WORKERS.set(key, worker); }
  return worker;
}

export function closePythonWorkers(): void {
  for (const worker of WORKERS.values()) worker.close();
  WORKERS.clear();
}
