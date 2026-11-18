import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { PythonWorker } from "../py-worker.js";

const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;
const workers: PythonWorker[] = [];
afterEach(() => { for (const worker of workers.splice(0)) worker.close(); });
const make = () => { const worker = new PythonWorker("python3"); workers.push(worker); return worker; };

describe.skipIf(!hasPython)("PythonWorker", () => {
  it("runs a script like python -c: argv in, stdout out, and keeps one process", async () => {
    const worker = make();
    const script = "import os, sys\nsys.stdout.write(sys.argv[1] + ':' + str(os.getpid()))";
    const first = await worker.run(script, ["a"], 5000);
    const second = await worker.run(script, ["b"], 5000);
    expect(first?.exitCode).toBe(0);
    expect(first?.stdout.startsWith("a:")).toBe(true);
    expect(second?.stdout.startsWith("b:")).toBe(true);
    expect(first?.stdout.split(":")[1]).toBe(second?.stdout.split(":")[1]);
  });

  it("honours SystemExit and reports an exception as a failed run, then keeps working", async () => {
    const worker = make();
    expect(await worker.run("import sys\nsys.stdout.write('x')\nraise SystemExit(0)", [], 5000)).toEqual({ exitCode: 0, stdout: "x" });
    expect((await worker.run("raise SystemExit(3)", [], 5000))?.exitCode).toBe(3);
    expect((await worker.run("raise ValueError('boom')", [], 5000))?.exitCode).toBe(1);
    expect((await worker.run("print('still alive')", [], 5000))?.stdout).toBe("still alive\n");
  });

  it("gives scripts a clean namespace each time", async () => {
    const worker = make();
    await worker.run("leak = 1", [], 5000);
    expect((await worker.run("print('leak' in globals())", [], 5000))?.stdout).toBe("False\n");
  });

  it("answers a hung script with a timeout result, drops the worker, and starts a fresh one for the next call", async () => {
    const worker = make();
    const hung = await worker.run("import time\ntime.sleep(30)", [], 300);
    expect(hung).toEqual({ exitCode: 124, stdout: "" });
    expect((await worker.run("print('fresh')", [], 5000))?.stdout).toBe("fresh\n");
  });

  it("declines when Python cannot start, so the caller can use a per-call process", async () => {
    const worker = new PythonWorker("/nonexistent/python3");
    workers.push(worker);
    expect(await worker.run("pass", [], 1000)).toBeUndefined();
  });
});
