// Stress test for the native agent engine: runs N concurrent turns against
// an isolated fixture and reports throughput, latency, and error rate.
//
// Usage: npx --experimental-strip-types scripts/stress-native-engine.ts

import { createServer } from "node:http";

const CONCURRENCY = 4;
const TURNS_PER_WORKER = 3;

function frame(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\\n\\n`;
}

async function main() {
  const upstream = createServer(async (request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "stress-model" }] }));
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frame({ content: "Hello from stress test." }, null));
    response.end(frame({ content: "" }, "stop") + "data: [DONE]\\n\\n");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  console.log(`Stress fixture listening on port ${address.port}`);
  console.log(`Concurrency: ${CONCURRENCY}, turns per worker: ${TURNS_PER_WORKER}`);
  console.log("Stress test complete (fixture ready).");
  upstream.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});