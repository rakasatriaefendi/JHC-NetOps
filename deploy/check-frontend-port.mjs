import net from "node:net";
import { pathToFileURL } from "node:url";

export async function checkListenPort(host, port, createServer = net.createServer) {
  if (typeof host !== "string" || !host.trim() || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw portError("FRONTEND_BIND_INVALID", "Frontend bind host or port is invalid");
  }

  await new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    server.once("error", (error) => finish(() => {
      if (error?.code === "EADDRINUSE") {
        reject(portError("FRONTEND_PORT_IN_USE", `Frontend startup blocked: ${host}:${port} is already occupied. Inspect it with: ss -ltnp 'sport = :${port}'`));
        return;
      }
      reject(portError("FRONTEND_BIND_UNAVAILABLE", `Frontend startup blocked: ${host}:${port} cannot be bound on this host`));
    }));
    server.once("listening", () => finish(() => server.close((error) => error ? reject(error) : resolve())));
    server.listen({ host, port, exclusive: true });
  });
}

function portError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readArguments(argv) {
  const hostIndex = argv.indexOf("--host");
  const portIndex = argv.indexOf("--port");
  return {
    host: hostIndex >= 0 ? argv[hostIndex + 1] : "",
    port: portIndex >= 0 ? Number(argv[portIndex + 1]) : Number.NaN,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { host, port } = readArguments(process.argv.slice(2));
  try {
    await checkListenPort(host, port);
    console.log(`Frontend bind preflight passed: ${host}:${port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Frontend bind preflight failed");
    process.exitCode = 1;
  }
}
