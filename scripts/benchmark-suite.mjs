#!/usr/bin/env node
/*
 * Benchmark suite: 25 small browser tasks, each measured the same way.
 *
 *   npm run benchmark:suite
 *   node scripts/benchmark-suite.mjs [--tasks id,id] [--runs n] [--out file]
 *
 * Every task is a local HTML page (benchmarks/suite/tasks/) and a scripted driver that makes the tool
 * calls an agent would make. Each task gets its own server process, its own OSSEO_HOME in a temp
 * directory, and its own headless Chrome (--headless=new, through browser.open). No display is used:
 * DISPLAY is removed from the server's environment, so the real screen is never touched.
 *
 * Per task:  success (the harness's own check of the page), tool calls, result bytes (the byte length of
 * each reply's JSON text, summed), wall-clock seconds, and refused (the task's expected refusal happened).
 * Not counted: the harness's final page snapshot, the `osseo confirm` the operator runs for the two
 * tasks that need a confirmation token, and writing the fixture file for the upload task.
 *
 * An unverified success is a task whose driver finished without an error (it would have reported
 * done) while the condition is false. The gate wants none.
 *
 * Gate: success rate at least 0.9 and zero unverified successes. Exit code 1 when the gate fails,
 * 2 when the build or a fixture is missing.
 *
 * The drivers are scripts, not a model: the numbers measure the tool surface on these pages and are a
 * regression gate, not a claim about any one agent.
 *
 * OSSEO_REPO points at another built tree (default: this one). The fixtures always come from this tree.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GATES, aggregate, evaluateGate, markdownTable, mergeRuns } from "./benchmark-suite-aggregate.mjs";

// The task definitions call tools by their full names.
process.env.OSSEO_TOOLS_PROFILE = "full";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILT = path.resolve(process.env.OSSEO_REPO ?? REPO);
const SERVER = path.join(BUILT, "packages/mcp-server/dist/index.js");
const CLI = path.join(BUILT, "packages/osseo-cli/dist/index.js");
const FIXTURES = path.join(REPO, "benchmarks/suite/tasks");
const DEFAULT_OUT = path.join(REPO, "benchmarks/suite/results/latest.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const options = { tasks: undefined, runs: 1, out: DEFAULT_OUT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${arg} needs a value`);
      return argv[index];
    };
    if (arg === "--tasks") options.tasks = value().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--runs") options.runs = Number.parseInt(value(), 10);
    else if (arg === "--out") options.out = path.resolve(value());
    else throw new Error(`unknown option ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) throw new Error("--runs must be a whole number from 1 to 20");
  return options;
}

/** Counts calls and reply bytes. Same wire handling as scripts/benchmark-form.mjs. */
function client(server) {
  const replies = new Map();
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) replies.set(message.id, message);
      } catch {
        /* Not a protocol message. */
      }
    }
  });
  let next = 100;
  const wait = async (id, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (replies.has(id)) return replies.get(id);
      if (server.exitCode !== null) throw new Error("the server exited");
      await sleep(25);
    }
    throw new Error(`no reply to request ${id}`);
  };
  return {
    async initialize() {
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "benchmark-suite", version: "1" } } })}\n`);
      await wait(1, 60_000);
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    },
    async send(name, args) {
      const id = next;
      next += 1;
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })}\n`);
      const reply = await wait(id);
      const content = reply.result?.content ?? [];
      const text = content.find((item) => item.type === "text")?.text ?? "";
      const images = content.filter((item) => item.type === "image");
      const bytes = Buffer.byteLength(text, "utf8") + images.reduce((sum, item) => sum + item.data.length, 0);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      return { body, bytes, ok: body?.ok === true, code: body?.error?.code };
    }
  };
}

async function stopServer(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  try {
    server.stdin.end();
  } catch {
    /* Already closed. */
  }
  const timer = setTimeout(() => server.kill("SIGKILL"), 8000);
  await exited;
  clearTimeout(timer);
}

/** What the operator does on the terminal: approve one exact preview. Not an agent tool call. */
function operatorConfirm(env, tokenId) {
  const result = spawnSync(process.execPath, [CLI, "confirm", tokenId, "--json"], { env, encoding: "utf8", timeout: 20_000 });
  try {
    return JSON.parse(result.stdout).ok === true;
  } catch {
    return false;
  }
}

/** The tool surface a driver sees. Every call through it is counted. */
function makeContext(mcp, env, work) {
  const stats = { calls: 0, bytes: 0 };
  const log = [];
  const t = {
    refused: false,
    async call(name, args = {}) {
      const result = await mcp.send(name, args);
      stats.calls += 1;
      stats.bytes += result.bytes;
      log.push({ tool: name, ok: result.ok, ...(result.code === undefined ? {} : { code: result.code }) });
      return result;
    },
    /** A call that must succeed; anything else ends the driver, which then reports nothing. */
    async must(name, args) {
      const result = await t.call(name, args);
      if (!result.ok) throw new Error(`${name} failed: ${result.code ?? "no reply"}`);
      return result;
    },
    /** A call that must be refused with one of the codes; sets t.refused when it was. */
    async expectRefused(name, args, codes) {
      const result = await t.call(name, args);
      if (!result.ok && codes.includes(result.code)) t.refused = true;
      return result;
    },
    /** Preview, operator approval, then the same call with its token: two counted tool calls. */
    async approved(name, args) {
      const preview = await t.must(name, { ...args, dryRun: true });
      const tokenId = preview.body?.confirmation?.tokenId;
      if (typeof tokenId !== "string") throw new Error(`${name}: the preview minted no token`);
      if (!operatorConfirm(env, tokenId)) throw new Error(`${name}: the operator could not confirm the preview`);
      return t.must(name, { ...args, confirmationToken: tokenId });
    },
    async open(fixture) {
      return t.must("browser.open", { url: pathToFileURL(path.join(FIXTURES, fixture)).toString(), headless: true });
    },
    /** A counted snapshot, with ref(name) to find an element by its exact name. */
    async snap(maxElements = 100) {
      const result = await t.must("browser.snapshot", { maxElements });
      return snapshotView(result.body?.data);
    },
    async makeFile(name, content) {
      const file = path.join(work, name);
      writeFileSync(file, content);
      return file;
    }
  };
  return { t, stats, log };
}

function snapshotView(data) {
  const elements = data?.elements ?? [];
  return {
    title: data?.title ?? "",
    text: data?.text ?? "",
    elements,
    ref(name) {
      const found = elements.find((item) => item.name === name);
      if (found === undefined) throw new Error(`no element named "${name}" on the page`);
      return found.ref;
    }
  };
}

async function runTask(task, root) {
  const home = mkdtempSync(path.join(root, "home-"));
  const work = mkdtempSync(path.join(root, "work-"));
  const config = path.join(home, "config.json");
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, overlay: { mode: "off" }, autoInstallDependencies: false }));
  const env = { ...process.env, OSSEO_HOME: home, OSSEO_CONFIG: config, OSSEO_TOOLS_PROFILE: "full" };
  // Headless Chrome needs no display; leaving it out makes touching the real screen impossible.
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  const server = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  server.stderr.resume();
  const mcp = client(server);
  const { t, stats, log } = makeContext(mcp, env, work);
  let reported = false;
  let conditionMet = false;
  let failure;
  let seconds = 0;
  try {
    await mcp.initialize();
    const started = process.hrtime.bigint();
    try {
      await task.run(t);
      reported = true;
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 160) : "driver error";
    }
    seconds = Number(process.hrtime.bigint() - started) / 1e9;
    try {
      // The harness's own look at the page. Uncounted, and the driver's result is not consulted.
      const probe = await mcp.send("browser.snapshot", { maxElements: 300 });
      conditionMet = probe.ok && task.check(snapshotView(probe.body?.data), t) === true;
    } catch {
      conditionMet = false;
    }
    if (!conditionMet && failure === undefined) failure = "condition not met";
  } catch (error) {
    failure = error instanceof Error ? error.message.slice(0, 160) : "harness error";
  } finally {
    await stopServer(server);
    try { rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* temp files only: a leftover must not fail the run */ }
    try { rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* temp files only: a leftover must not fail the run */ }
  }
  return {
    id: task.id,
    success: reported && conditionMet,
    reported,
    conditionMet,
    refused: task.expectRefusal !== undefined && t.refused,
    calls: stats.calls,
    bytes: stats.bytes,
    seconds: Math.round(seconds * 100) / 100,
    tools: log,
    ...(failure === undefined ? {} : { failure })
  };
}

function chromeVersion() {
  for (const binary of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) {
    try {
      return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    } catch {
      /* Try the next one. */
    }
  }
  return "unknown";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { TASKS } = await import(pathToFileURL(path.join(FIXTURES, "index.mjs")).toString());
  for (const required of [SERVER, CLI]) {
    if (!existsSync(required)) {
      console.log(`Missing ${path.relative(BUILT, required)}. Run npm run build first.`);
      process.exitCode = 2;
      return;
    }
  }
  const selected = options.tasks === undefined ? TASKS : options.tasks.map((id) => {
    const found = TASKS.find((task) => task.id === id);
    if (found === undefined) throw new Error(`unknown task ${id}; known: ${TASKS.map((task) => task.id).join(", ")}`);
    return found;
  });
  for (const task of selected) {
    if (!existsSync(path.join(FIXTURES, task.fixture))) {
      console.log(`Missing fixture ${task.fixture}.`);
      process.exitCode = 2;
      return;
    }
  }
  const version = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")).version;
  const root = mkdtempSync(path.join(os.tmpdir(), "osseo-suite-"));
  const perTask = [];
  try {
    for (const task of selected) {
      const runs = [];
      for (let run = 0; run < options.runs; run += 1) {
        let result = await runTask(task, root);
        process.stderr.write(`${result.success ? "pass" : "FAIL"}  ${task.id}${result.failure === undefined ? "" : `  (${result.failure})`}\n`);
        // One timing hiccup (a headless Chrome page that settles late on a busy runner) must not fail the gate, and must
        // not hide a real regression either: a failed task gets exactly one more try, the retry is what counts, and the
        // first failure stays visible in the log, the summary and the results file. A task that fails twice fails.
        if (!result.success) {
          const first = result.failure ?? "failed";
          result = { ...(await runTask(task, root)), retriedAfter: first };
          process.stderr.write(`${result.success ? "pass" : "FAIL"}  ${task.id}  (retry after: ${first})${result.failure === undefined ? "" : `  (${result.failure})`}\n`);
        }
        runs.push(result);
      }
      perTask.push({ task, runs });
    }
  } finally {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* temp files only: a leftover must not fail the run */ }
  }

  const rows = perTask.map(({ runs }) => mergeRuns(runs));
  const summary = aggregate(rows);
  const gate = evaluateGate(summary);

  const output = {
    header: {
      osseoVersion: version,
      toolProfile: "full",
      chrome: chromeVersion(),
      date: new Date().toISOString(),
      runsPerTask: options.runs,
      taskCount: rows.length
    },
    summary,
    gate: { ...gate.gates, successRateOk: gate.successRateOk, unverifiedOk: gate.unverifiedOk, pass: gate.pass },
    tasks: perTask.map(({ task, runs }, index) => ({
      id: task.id,
      goal: task.goal,
      fixture: task.fixture,
      ...rows[index],
      // Tool calls and outcomes of the first run: names and codes only, never page content or typed text.
      toolCalls: runs[0].tools,
      ...(runs.find((run) => run.failure !== undefined) === undefined ? {} : { failure: runs.find((run) => run.failure !== undefined).failure }),
      ...(runs.find((run) => run.retriedAfter !== undefined) === undefined ? {} : { retriedAfter: runs.find((run) => run.retriedAfter !== undefined).retriedAfter })
    }))
  };
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Osseo ${version}, tools profile full, ${output.header.chrome}, ${output.header.date}, ${options.runs} run(s) per task`);
  console.log("");
  console.log(markdownTable(rows));
  console.log("");
  console.log(`tasks ${summary.tasks}, passed ${summary.succeeded}, success rate ${summary.successRate}`);
  console.log(`tool calls: median ${summary.medianCalls}, total ${summary.totalCalls}; result bytes total ${summary.totalBytes}; seconds: median ${summary.medianSeconds}, total ${summary.totalSeconds}`);
  console.log(`refusals that were expected and happened: ${summary.refusals}; unverified successes: ${summary.unverifiedSuccesses}`);
  const retried = perTask.flatMap(({ task, runs }) => runs.filter((run) => run.retriedAfter !== undefined).map((run) => `${task.id} (${run.retriedAfter}; ${run.success ? "passed on retry" : "failed again"})`));
  console.log(retried.length === 0 ? "retries: none" : `retries: ${retried.join(", ")}`);
  console.log("");
  console.log(`gate: success rate >= ${GATES.minSuccessRate} (${summary.successRate}: ${gate.successRateOk ? "ok" : "FAIL"}), unverified successes == ${GATES.maxUnverifiedSuccesses} (${summary.unverifiedSuccesses}: ${gate.unverifiedOk ? "ok" : "FAIL"})`);
  console.log(`gate result: ${gate.pass ? "PASS" : "FAIL"}`);
  console.log(`wrote ${path.relative(REPO, options.out) || options.out}`);
  const anyTaskFailed = summary.failed > 0;
  process.exitCode = gate.pass && !anyTaskFailed ? 0 : 1;
}

main().catch((error) => {
  console.log(`ERROR  ${error.message}`);
  process.exitCode = 1;
});
