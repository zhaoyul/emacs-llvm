#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { ContentLengthFramer, encodeContentLengthFrame } from "./framing.mjs";
import { createDriverRuntime } from "./runtime.mjs";
import { createLinuxBackend, LinuxDriverError } from "./x11-backend.mjs";

const MAX_CONNECTIONS = 16;
const MAX_REQUESTS_PER_CONNECTION = 10_000;

function secureEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function rpcSuccess(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcFailure(id, error) {
  const driverError = error instanceof LinuxDriverError
    ? error
    : new LinuxDriverError("E_INTERNAL", error instanceof Error ? error.message : String(error));
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message: driverError.message,
      data: {
        code: driverError.code,
        ...(driverError.details === undefined ? {} : { details: driverError.details })
      }
    }
  };
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LinuxDriverError("E_INVALID_ARGUMENT", `${name} must be an object.`);
  }
  return value;
}

function decodeTarget(params) {
  const target = object(params.target, "target");
  return {
    pid: Number(target.pid),
    window_title: typeof target.window_title === "string" ? target.window_title : undefined,
    window_identifier: typeof target.window_identifier === "string" ? target.window_identifier : undefined
  };
}

async function main() {
  if (process.platform !== "linux") {
    process.stderr.write("Emacs Operator Linux Host can run only on Linux.\n");
    process.exitCode = 64;
    return;
  }

  const runtime = createDriverRuntime();
  const backend = await createLinuxBackend({ runtimeDirectory: runtime.directory });
  const server = net.createServer();
  let connectionCount = 0;
  let shuttingDown = false;
  const sockets = new Set();

  async function dispatch(method, params) {
    switch (method) {
      case "driver.capabilities":
        return await backend.capabilities();
      case "driver.permissions":
        return await backend.permissions();
      case "driver.frontmost":
        return await backend.frontmostApplication();
      case "driver.focus": {
        const options = params.options && typeof params.options === "object" ? params.options : {};
        return await backend.focusEmacs(decodeTarget(params), options);
      }
      case "driver.key_sequence": {
        const sequence = object(params.sequence, "sequence");
        if (!Array.isArray(sequence.events)) throw new LinuxDriverError("E_INVALID_ARGUMENT", "sequence.events must be an array.");
        const options = params.focus_options && typeof params.focus_options === "object" ? params.focus_options : {};
        return await backend.sendKeySequence(decodeTarget(params), sequence.events, options);
      }
      case "driver.restore_application": {
        const application = object(params.application, "application");
        return { restored: await backend.restoreApplication(application) };
      }
      case "driver.capture": {
        const options = params.options && typeof params.options === "object" ? params.options : {};
        return await backend.captureEmacs(decodeTarget(params), options);
      }
      case "driver.cancel_all":
        await backend.cancelAll();
        return { cancelled: true };
      default:
        throw new LinuxDriverError("E_INVALID_ARGUMENT", `Unsupported driver RPC method: ${method}.`);
    }
  }

  server.on("connection", (socket) => {
    if (connectionCount >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    connectionCount += 1;
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(30_000, () => socket.destroy());
    const framer = new ContentLengthFramer();
    let authorized = false;
    let requestCount = 0;
    let chain = Promise.resolve();

    socket.on("data", (chunk) => {
      let frames;
      try { frames = framer.push(chunk); }
      catch { socket.destroy(); return; }
      for (const frame of frames) {
        chain = chain.then(async () => {
          if (socket.destroyed) return;
          let id = null;
          try {
            const request = JSON.parse(frame.toString("utf8"));
            id = request?.id ?? null;
            if (request?.jsonrpc !== "2.0" || typeof request?.method !== "string") {
              throw new LinuxDriverError("E_INVALID_ARGUMENT", "Malformed driver JSON-RPC request.");
            }
            if (++requestCount > MAX_REQUESTS_PER_CONNECTION) {
              throw new LinuxDriverError("E_PERMISSION_DENIED", "Driver connection request limit exceeded.");
            }
            const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
              ? request.params
              : {};
            let result;
            if (request.method === "driver.initialize") {
              if (!secureEqual(params.token, runtime.token)) throw new LinuxDriverError("E_AUTH_FAILED", "Driver token is invalid.");
              authorized = true;
              result = await backend.capabilities();
            } else {
              if (!authorized) throw new LinuxDriverError("E_AUTH_FAILED", "Driver connection is not initialized.");
              result = await dispatch(request.method, params);
            }
            socket.write(encodeContentLengthFrame(rpcSuccess(id, result)));
          } catch (error) {
            socket.write(encodeContentLengthFrame(rpcFailure(id, error)));
          }
        }).catch(() => socket.destroy());
      }
    });
    socket.on("close", () => {
      connectionCount -= 1;
      sockets.delete(socket);
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Linux Host did not obtain a TCP port.");
  runtime.writeRecord(address.port);
  const heartbeat = setInterval(() => {
    try { runtime.writeRecord(address.port); }
    catch (error) {
      process.stderr.write(`Linux Host heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }, 5000);
  heartbeat.unref();

  const capabilities = await backend.capabilities();
  process.stderr.write(`Emacs Operator Linux Host running on 127.0.0.1:${address.port}, backend=${capabilities.backend ?? "unknown"}.\n`);

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    await backend.cancelAll().catch(() => {});
    backend.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(() => resolve()));
    try { runtime.cleanup(); } catch {}
    if (signal) process.stderr.write(`Emacs Operator Linux Host stopped by ${signal}.\n`);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => shutdown(signal).finally(() => process.exit(signal === "SIGINT" ? 130 : 0)));
  }
  process.on("exit", () => {
    try { runtime.cleanup(); } catch {}
  });
}

main().catch((error) => {
  process.stderr.write(`Emacs Operator Linux Host failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
