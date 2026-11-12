#!/usr/bin/env node
// AgentHost native messaging host. The browser starts it and talks over stdin/stdout with Chrome's framing
// (4-byte little-endian length + JSON). Requests from the AgentHost process arrive on a private unix socket,
// are checked here (type, fields, allowed host: defence in depth) and then forwarded to the extension.
// Nothing but frames is ever written to stdout; logs go to stderr.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FrameDecoder, encodeFrame, checkRequest, validateResponse, REFUSALS } from "../src/protocol.mjs";

const log = (...args) => process.stderr.write(args.join(" ") + "\n");

export function defaultAllowedHostsFile(home = os.homedir()) {
  return process.env.AGENTHOST_BROWSER_ALLOWED_HOSTS_FILE || path.join(home, ".agenthost", "browser-extension", "allowed-hosts.json");
}

/** Read on every request so changes apply without a restart. A missing or bad file allows nothing. */
export function readAllowedHosts(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.filter((h) => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/** Routes requests from clients to the extension and responses back. `toExtension(frameBuffer)` writes to stdout. */
export function createRelay({ getAllowedHosts, toExtension }) {
  let counter = 0;
  const pending = new Map();
  return {
    fromClient(message, reply) {
      const checked = checkRequest(message, getAllowedHosts());
      const clientId = message && typeof message === "object" ? message.id : undefined;
      if (!checked.ok) return reply({ id: clientId, ok: false, reason: checked.reason });
      const internal = "r" + ++counter;
      pending.set(internal, { reply, clientId });
      try {
        toExtension(encodeFrame({ ...checked.request, id: internal }));
      } catch (error) {
        pending.delete(internal);
        reply({ id: clientId, ok: false, reason: error.message === REFUSALS.tooLarge ? REFUSALS.tooLarge : "write_failed" });
      }
    },
    fromExtension(message) {
      if (!validateResponse(message)) return log("dropped malformed response");
      const entry = pending.get(message.id);
      if (!entry) return log("dropped response with unknown id");
      pending.delete(message.id);
      entry.reply({ ...message, id: entry.clientId });
    },
    failAll(reason) {
      for (const entry of pending.values()) entry.reply({ id: entry.clientId, ok: false, reason });
      pending.clear();
    }
  };
}

function main() {
  const home = os.homedir();
  const allowedFile = defaultAllowedHostsFile(home);
  const runDir = path.join(home, ".agenthost", "run");
  const socketPath = process.env.AGENTHOST_BROWSER_SOCKET || path.join(runDir, "browser-extension.sock");
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(socketPath); } catch { /* none */ }

  const relay = createRelay({
    getAllowedHosts: () => readAllowedHosts(allowedFile),
    toExtension: (frame) => process.stdout.write(frame)
  });

  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      let messages;
      try { messages = decoder.push(chunk); } catch (error) { socket.end(encodeFrame({ ok: false, reason: error.message })); return; }
      for (const message of messages) relay.fromClient(message, (body) => { if (!socket.destroyed) socket.write(encodeFrame(body)); });
    });
    socket.on("error", () => {});
  });
  server.listen(socketPath, () => { try { fs.chmodSync(socketPath, 0o600); } catch { /* best effort */ } });

  const decoder = new FrameDecoder();
  process.stdin.on("data", (chunk) => {
    try { for (const message of decoder.push(chunk)) relay.fromExtension(message); } catch (error) { log("bad frame from extension:", error.message); process.exit(1); }
  });
  process.stdin.on("end", () => { relay.failAll("extension_disconnected"); server.close(); try { fs.unlinkSync(socketPath); } catch { /* gone */ } process.exit(0); });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
