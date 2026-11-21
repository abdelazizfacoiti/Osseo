#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultOsseoHome } from "@osseo/core";
import { startHost } from "./host.js";
import { HostError } from "./socket.js";

/* Host process entry: `node dist/host/main.js`. Started by the shim or `osseo host start`. */

export async function runHostMain(): Promise<void> {
  const agentHome = path.resolve(process.env.OSSEO_HOME ?? defaultOsseoHome(os.homedir()));
  let host;
  try {
    host = await startHost({ agentHome });
  } catch (error) {
    // Another host won the race: that is fine for a shim that started us.
    if (error instanceof HostError && error.code === "osseo_host_running") process.exit(0);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  const stop = (code: number): void => {
    const deadline = setTimeout(() => process.exit(code), 6_000);
    void host.close("signal").finally(() => { clearTimeout(deadline); process.exit(code); });
  };
  process.once("SIGTERM", () => stop(143));
  process.once("SIGINT", () => stop(130));
  process.once("SIGHUP", () => stop(129));
  void host.closed.then(() => process.exit(0));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runHostMain();
}
