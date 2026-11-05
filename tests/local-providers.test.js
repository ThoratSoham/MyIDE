const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { installElectronStub } = require("./helpers/harness");

installElectronStub();

const { AIService } = require("../dist/main/ai/service");
const { setProviderKey, setSettings } = require("../dist/main/store");

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r) => {
            try {
              if (typeof server.closeAllConnections === "function") {
                server.closeAllConnections();
              }
            } catch (_) {}
            server.close(() => {
              setImmediate(r);
            });
            try {
              server.unref();
            } catch (_) {}
          }),
      });
    });
  });
}

test("Local Model Adapter: auto-detects Ollama & LM Studio, filters embedding models, and streams OpenAI-compatible SSE", async () => {
  const ollamaMock = await startMockServer((req, res) => {
    if (req.url === "/api/tags" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: "qwen2.5-coder:7b",
              size: 4_700_000_000,
              details: { family: "qwen2", parameter_size: "7.6B" },
            },
            {
              name: "llama3.2:1b",
              size: 1_100_000_000,
              details: { family: "llama", parameter_size: "1B" },
            },
            {
              name: "nomic-embed-text:latest",
              size: 274_000_000,
              details: { family: "nomic-bert", parameter_size: "137M" },
            },
          ],
        }),
      );
      return;
    }

    if (req.url === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        if (parsed.stream === false) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: "OK" } }],
              usage: { prompt_tokens: 8, completion_tokens: 1 },
            }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"{\\"thought\\":\\"local\\","}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"\\"answer\\":\\"hello from ollama\\"}"}}],"usage":{"prompt_tokens":15,"completion_tokens":8}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const lmStudioMock = await startMockServer((req, res) => {
    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: [{ id: "deepseek-coder-v2-lite-instruct" }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    setProviderKey("gemini", "");
    setProviderKey("groq", "");
    setProviderKey("openrouter", "");
    setSettings({
      localModelsEnabled: true,
      ollamaBaseUrl: ollamaMock.url,
      lmStudioBaseUrl: lmStudioMock.url,
      selectedLocalModel: "",
    });

    const svc = new AIService();
    svc.init({ skipLiveFetch: true });
    const detected = await svc.detectLocalModels();

    assert.equal(detected.ollamaOnline, true);
    assert.equal(detected.lmStudioOnline, true);
    // nomic-embed-text must be excluded from chat lanes!
    assert.equal(detected.models.length, 3);
    const coder = detected.models.find((m) => m.id === "qwen2.5-coder:7b");
    const tiny = detected.models.find((m) => m.id === "llama3.2:1b");
    assert.equal(coder.capableForEdits, true);
    assert.equal(tiny.capableForEdits, false);

    // Without cloud keys, detected local models replace offline mode!
    assert.equal(svc.isOfflineMode(), false);

    // Test button endpoint
    const testRes = await svc.testLocalModel("ollama", "qwen2.5-coder:7b");
    assert.equal(testRes.ok, true);
    assert.match(testRes.message, /responded/);

    // Complete request streams from local Ollama instead of static offline starter pack
    const deltas = [];
    const comp = await svc.complete(
      "chat",
      [{ role: "user", content: "Say hello" }],
      { onDelta: (d) => deltas.push(d) },
    );
    assert.equal(comp.ok, true);
    assert.equal(comp.laneUsed.provider, "ollama");
    assert.match(comp.content, /hello from ollama/);
    assert.ok(deltas.length >= 2);
  } finally {
    await ollamaMock.close();
    await lmStudioMock.close();
  }
});

test("Local Model Adapter: prioritizes local lanes for classify/summarize/chat & simple edits, keeps cloud primary for codegen/repair", async () => {
  const ollamaMock = await startMockServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          models: [{ name: "qwen2.5-coder:7b", size: 4_700_000_000 }],
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    setProviderKey("gemini", "test-cloud-key");
    setSettings({
      localModelsEnabled: true,
      ollamaBaseUrl: ollamaMock.url,
      lmStudioBaseUrl: "http://127.0.0.1:9", // offline port
      selectedLocalModel: "",
    });

    const svc = new AIService();
    svc.init({ skipLiveFetch: true });
    await svc.detectLocalModels(300);

    const classifyOrder = svc.router.config.getLanes("classify");
    const summarizeOrder = svc.router.config.getLanes("summarize");
    const chatOrder = svc.router.config.getLanes("chat");
    const planOrder = svc.router.config.getLanes("plan");
    const codegenOrder = svc.router.config.getLanes("codegen");
    const repairOrder = svc.router.config.getLanes("repair");

    // Light tasks + simple plan/edit go to local unlimited coder lane first!
    assert.equal(classifyOrder[0].provider, "ollama");
    assert.equal(summarizeOrder[0].provider, "ollama");
    assert.equal(chatOrder[0].provider, "ollama");
    assert.equal(planOrder[0].provider, "ollama");

    // Hard codegen & repair keep cloud lanes primary, with local lane at the tail as safety net!
    assert.equal(codegenOrder[0].provider, "gemini");
    assert.equal(repairOrder[0].provider, "gemini");
    assert.ok(codegenOrder.some((l) => l.provider === "ollama"));
  } finally {
    setProviderKey("gemini", "");
    setSettings({
      localModelsEnabled: true,
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:1234",
    });
    await ollamaMock.close();
  }
});

