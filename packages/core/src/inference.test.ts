/**
 * Inference detection and normalisation.
 *
 * Metric bodies here are shaped like the real thing, including the label sets
 * that force a sum (vLLM splits request_success_total by finished_reason).
 */

import { describe, expect, test } from "bun:test";
import { detectEngine, parsePrometheus, readMetrics, readOllama, readOpenAiModels } from "./inference.ts";
import { parseDiscoveredEndpoints, parseInferenceScrapes } from "./parse.ts";
import { US } from "./probe.ts";

const VLLM = `# HELP vllm:num_requests_running Number running
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="deepseek-v4-flash-0731"} 3.0
vllm:num_requests_waiting{engine="0",model_name="deepseek-v4-flash-0731"} 1.0
vllm:prompt_tokens_total{engine="0",model_name="deepseek-v4-flash-0731"} 3.1290591e+07
vllm:generation_tokens_total{engine="0",model_name="deepseek-v4-flash-0731"} 197122.0
vllm:request_success_total{engine="0",finished_reason="stop",model_name="deepseek-v4-flash-0731"} 431.0
vllm:request_success_total{engine="0",finished_reason="length",model_name="deepseek-v4-flash-0731"} 1.0
vllm:kv_cache_usage_perc{engine="0",model_name="deepseek-v4-flash-0731"} 0.42`;

describe("prometheus parsing", () => {
  test("handles labels, exponent notation and comments", () => {
    const m = parsePrometheus(VLLM);
    expect(m.get("vllm:num_requests_running")![0]!.value).toBe(3);
    expect(m.get("vllm:prompt_tokens_total")![0]!.value).toBe(31290591);
    expect(m.get("vllm:num_requests_running")![0]!.labels.model_name).toBe("deepseek-v4-flash-0731");
  });

  test("ignores malformed lines instead of throwing", () => {
    expect(parsePrometheus("garbage\nvllm:x 1\n{broken\n").get("vllm:x")![0]!.value).toBe(1);
  });
});

describe("engine detection", () => {
  test("identifies vLLM", () => {
    expect(detectEngine(VLLM)!.id).toBe("vllm");
  });

  test.each([
    ["sglang:num_running_reqs 2", "sglang"],
    ["llamacpp:requests_processing 1", "llamacpp"],
    ["tgi_queue_size 4", "tgi"],
    ["nv_inference_request_success 9", "triton"],
  ] as const)("identifies %s", (body, expected) => {
    expect(detectEngine(body)!.id).toBe(expected);
  });

  test("returns null for something that is not an inference server", () => {
    expect(detectEngine("go_gc_duration_seconds 0.1\nnode_cpu_seconds_total 5")).toBeNull();
  });
});

describe("normalisation", () => {
  test("sums counters split across label sets", () => {
    const r = readMetrics(VLLM)!;
    // 431 stop + 1 length
    expect(r.requestsFinishedTotal).toBe(432);
    expect(r.requestsRunning).toBe(3);
    expect(r.requestsWaiting).toBe(1);
    expect(r.generationTokensTotal).toBe(197122);
    expect(r.models).toEqual(["deepseek-v4-flash-0731"]);
  });

  test("scales a 0-1 cache ratio onto a percentage", () => {
    expect(readMetrics(VLLM)!.kvCachePct).toBeCloseTo(42, 5);
  });

  test("leaves an already-scaled percentage alone", () => {
    const r = readMetrics(`vllm:num_requests_running 0\nvllm:kv_cache_usage_perc 73.5`)!;
    expect(r.kvCachePct).toBeCloseTo(73.5, 5);
  });

  test("reads Ollama's model list", () => {
    const r = readOllama('{"models":[{"name":"llama3:8b"},{"name":"qwen2:7b"}]}')!;
    expect(r.engine).toBe("ollama");
    expect(r.models).toEqual(["llama3:8b", "qwen2:7b"]);
  });

  test("reads an OpenAI-compatible model list", () => {
    expect(readOpenAiModels('{"object":"list","data":[{"id":"gpt-x"}]}')).toEqual(["gpt-x"]);
    expect(readOpenAiModels("not json")).toEqual([]);
  });
});

describe("probe output", () => {
  test("parses discovered endpoints and drops duplicates", () => {
    const body = [
      ["PORT", "8888", "metrics"].join(US),
      ["PORT", "11434", "ollama"].join(US),
      ["PORT", "8888", "metrics"].join(US),
      ["PORT", "99", "bogus"].join(US),
    ].join("\n");
    expect(parseDiscoveredEndpoints(body)).toEqual([
      { port: 8888, kind: "metrics" },
      { port: 11434, kind: "ollama" },
    ]);
  });

  test("splits scrapes into per-endpoint bodies", () => {
    const body =
      `EP${US}8888${US}metrics\nvllm:num_requests_running 2\n${US}END${US}\n` +
      `EP${US}11434${US}ollama\n{"models":[]}\n${US}END${US}\n`;
    const parts = parseInferenceScrapes(body);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.port).toBe(8888);
    expect(parts[0]!.body).toContain("vllm:num_requests_running 2");
    expect(parts[1]!.kind).toBe("ollama");
  });

  test("keeps an endpoint that returned nothing", () => {
    const parts = parseInferenceScrapes(`EP${US}8888${US}metrics\n${US}END${US}\n`);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.body).toBe("");
  });
});
