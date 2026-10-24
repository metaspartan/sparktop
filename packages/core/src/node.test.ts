import { describe, expect, test } from "bun:test";
import { NodeCollector } from "./node";
import type { InferenceEndpoint } from "./types";

// Drive the same scrape-to-endpoint boundary used by the collector, without SSH.
function fixture() {
  const collector = new NodeCollector({ id: "n1", host: "localhost", username: "test", port: 22, enabled: true, addedAt: 0 }, { fastMs: 1000, slowMs: 10000 });
  return (t: number, completed: number, live: number, running: number, engine = "tensorfold"): InferenceEndpoint => {
    const body = [
      `${engine}:requests_running ${running}`,
      `${engine}:requests_waiting 0`,
      `${engine}:generation_tokens_total ${completed}`,
      ...(engine === "tensorfold" ? [`tensorfold:generation_tokens_running ${live}`] : []),
      `${engine}:prompt_tokens_total 100`,
      `${engine}:request_decode_time_seconds_count 1`,
    ].join("\n");
    const boundary = collector as unknown as { buildInference(s: Record<string, string>, ts: number): InferenceEndpoint[] };
    return boundary.buildInference({ infer: `EP\x1f8888\x1fmetrics\n${body}\n\x1fEND\x1f\n` }, t)[0]!;
  };
}

describe("TensorFold live throughput", () => {
  test("streams before completion and transfers tokens exactly once at the boundary", () => {
    const sample = fixture();
    expect(sample(0, 1000, 0, 0).decodeTokensPerSec).toBeNull();
    const live = sample(1000, 1000, 60, 1);
    expect(live.decodeTokensPerSec).toBe(60);
    expect(live.generationTokensTotal).toBe(1000);
    expect(sample(2000, 1000, 120, 1).decodeTokensPerSec).toBe(60);
    const finished = sample(3000, 1180, 0, 0);
    expect(finished.decodeTokensPerSec).toBe(60);
    expect(finished.generationTokensTotal).toBe(1180);
    expect(sample(4000, 1180, 60, 1).decodeTokensPerSec).toBe(60);
    expect(sample(20000, 1240, 0, 0).decodeTokensPerSec).toBe(0);
    expect(sample(21000, 0, 0, 0).decodeTokensPerSec).toBeNull();
  });
});
