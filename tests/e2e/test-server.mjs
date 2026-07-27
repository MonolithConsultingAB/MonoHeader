import https from "node:https";
import selfsigned from "selfsigned";

export async function startTestServer() {
  const state = {
    keepAliveRequests: 0,
    requests: []
  };
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      algorithm: "sha256",
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: false },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true
        },
        {
          name: "subjectAltName",
          altNames: [
            { type: 2, value: "localhost" },
            { type: 7, ip: "127.0.0.1" }
          ]
        }
      ]
    }
  );
  const server = https.createServer({
    key: pems.private,
    cert: pems.cert
  }, (request, response) => {
    const url = new URL(request.url || "/", "https://localhost");
    state.requests.push({
      method: request.method || "GET",
      path: url.pathname,
      e2eHeader: String(request.headers["x-monoheader-e2e"] || "")
    });

    if (url.pathname === "/health") {
      send(response, 200, "text/plain; charset=utf-8", "ok");
      return;
    }
    if (url.pathname === "/api/session/keepalive") {
      state.keepAliveRequests += 1;
      response.writeHead(204, {
        "cache-control": "no-store"
      });
      response.end();
      return;
    }
    if (url.pathname === "/headers") {
      send(response, 200, "text/html; charset=utf-8", pageDocument(
        "Header fixture",
        `<output id="received-header">${escapeHtml(request.headers["x-monoheader-e2e"] || "")}</output>`
      ));
      return;
    }
    send(response, 200, "text/html; charset=utf-8", pageDocument(
      "Activity fixture",
      [
        '<output id="mousemove-count">0</output>',
        '<output id="click-count">0</output>',
        "<script>",
        "const counts = { mousemove: 0, click: 0 };",
        "for (const type of Object.keys(counts)) {",
        "  document.addEventListener(type, (event) => {",
        "    if (event.isTrusted) return;",
        "    counts[type] += 1;",
        "    document.getElementById(`${type}-count`).textContent = String(counts[type]);",
        "  });",
        "}",
        "</script>"
      ].join("")
    ));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The local MonoHeader E2E server did not expose a TCP port.");
  }
  const port = address.port;
  return {
    origin: `https://127.0.0.1:${port}`,
    alternateOrigin: `https://localhost:${port}`,
    state,
    reset() {
      state.keepAliveRequests = 0;
      state.requests.length = 0;
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  };
}

function pageDocument(title, body) {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    `<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>`,
    "</html>"
  ].join("");
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
