/**
 * Inference detection and normalisation.
 *
 * Metric bodies here are shaped like the real thing, including the label sets
 * that force a sum (vLLM splits request_success_total by finished_reason).
 */

import { describe, expect, test } from "bun:test";
import {
  counterIntervalRatio,
  detectEngine,
  histogramIntervalMean,
  histogramLifetimeMean,
  parsePrometheus,
  readMetrics,
  readOllama,
  readOpenAiModels,
} from "./inference.ts";
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

describe("latency histograms", () => {
  const at = (sum: number, count: number) => ({ sum, count });

  test("averages over the interval, not the server's lifetime", () => {
    // Lifetime mean is 3431/705 = 4.9s, but the last two requests averaged 1s.
    const before = at(3431, 705);
    const now = at(3433, 707);
    expect(histogramIntervalMean(before, now)).toBeCloseTo(1, 5);
    expect(histogramLifetimeMean(now)).toBeCloseTo(4.855, 2);
  });

  test("returns null when nothing completed in the interval", () => {
    // An idle server: no new samples, so there is no average to report.
    expect(histogramIntervalMean(at(100, 10), at(100, 10))).toBeNull();
  });

  test("returns null when counters reset", () => {
    expect(histogramIntervalMean(at(3431, 705), at(2, 1))).toBeNull();
  });

  test("returns null without a prior scrape", () => {
    expect(histogramIntervalMean(undefined, at(10, 2))).toBeNull();
  });

  test("reads sum and count out of a real vLLM body", () => {
    const body = `vllm:num_requests_running 1
vllm:time_to_first_token_seconds_count{model_name="m"} 705.0
vllm:time_to_first_token_seconds_sum{model_name="m"} 3431.7467172145844
vllm:inter_token_latency_seconds_count{model_name="m"} 110186.0
vllm:inter_token_latency_seconds_sum{model_name="m"} 10130.906027254
vllm:prompt_tokens_total{model_name="m"} 7.2873213e+07
vllm:prompt_tokens_cached_total{model_name="m"} 6.9694976e+07`;
    const r = readMetrics(body)!;
    expect(r.latency.ttft).toEqual({ sum: 3431.7467172145844, count: 705 });
    expect(r.latency.interToken!.count).toBe(110186);
    // Prefix cache carries the great majority of prompt tokens here.
    expect(r.cachedPromptTokensTotal).toBeCloseTo(69694976, 0);
    expect(r.promptTokensTotal).toBeCloseTo(72873213, 0);
  });

  test("leaves latency empty for an engine that exposes none", () => {
    expect(readMetrics("llamacpp:requests_processing 1")!.latency).toEqual({});
  });
});

describe("counter interval ratios", () => {
  test("uses the window, not the lifetime totals", () => {
    // Lifetime says 90% accepted; the last window says 50%. A long-running
    // server must report what is happening now, not its whole history.
    expect(counterIntervalRatio(9000, 10000, 9100, 10200)).toBeCloseTo(0.5, 6);
  });

  test("falls back to the lifetime ratio without a baseline", () => {
    expect(counterIntervalRatio(undefined, undefined, 9000, 10000)).toBeCloseTo(0.9, 6);
  });

  test("falls back when the denominator has not advanced", () => {
    // An idle window carries no information, so the lifetime ratio stands in
    // rather than a division by zero.
    expect(counterIntervalRatio(9000, 10000, 9000, 10000)).toBeCloseTo(0.9, 6);
  });

  test("falls back when a counter goes backwards", () => {
    // Restarted server: the new totals are the only truthful reading.
    expect(counterIntervalRatio(9000, 10000, 5, 10)).toBeCloseTo(0.5, 6);
  });

  test("is null when nothing was ever measured", () => {
    expect(counterIntervalRatio(undefined, undefined, 0, 0)).toBeNull();
    expect(counterIntervalRatio(undefined, undefined, undefined, 10)).toBeNull();
  });

  test("mean accepted length counts the target model's bonus token", () => {
    // 300 accepted drafts over 200 steps is 1.5 per step, plus the token the
    // target model emits itself on every step.
    const perDraft = counterIntervalRatio(0, 0, 300, 200)!;
    expect(perDraft + 1).toBeCloseTo(2.5, 6);
    // It can never sit below 1, even when every draft is rejected.
    expect(counterIntervalRatio(0, 0, 0, 200)! + 1).toBe(1);
  });
});

describe("token accounting across engines", () => {
  /*
   * The token chart is engine-neutral, so every supported engine has to yield
   * input and output from its own metric names. Cached prompt tokens are a
   * different matter: vLLM and SGLang count them, llama.cpp and TGI do not
   * expose such a counter at all, and the right answer there is absence rather
   * than a zero that would draw a "nothing cached" line.
   */
  const bodies: Record<string, string> = {
    vllm: `vllm:num_requests_running 2
vllm:prompt_tokens_total 1000
vllm:generation_tokens_total 300
vllm:prompt_tokens_cached_total 850`,
    sglang: `sglang:num_running_reqs 2
sglang:prompt_tokens_total 1000
sglang:generation_tokens_total 300
sglang:cached_tokens_total 700`,
    llamacpp: `llamacpp:requests_processing 1
llamacpp:prompt_tokens_total 1000
llamacpp:tokens_predicted_total 300`,
    tgi: `tgi_queue_size 0
tgi_request_input_length_sum 1000
tgi_request_generated_tokens_sum 300`,
  };

  test.each(Object.keys(bodies))("%s reports input and output tokens", (engine) => {
    const r = readMetrics(bodies[engine]!)!;
    expect(String(detectEngine(bodies[engine]!)!.id)).toBe(engine);
    expect(r.promptTokensTotal).toBe(1000);
    expect(r.generationTokensTotal).toBe(300);
  });

  test("counts cached prompt tokens where the engine exposes them", () => {
    expect(readMetrics(bodies.vllm!)!.cachedPromptTokensTotal).toBe(850);
    expect(readMetrics(bodies.sglang!)!.cachedPromptTokensTotal).toBe(700);
  });

  test("leaves cached tokens absent where the engine has no such counter", () => {
    // Undefined, not 0 — the chart drops the series rather than claiming the
    // cache served nothing.
    expect(readMetrics(bodies.llamacpp!)!.cachedPromptTokensTotal).toBeUndefined();
    expect(readMetrics(bodies.tgi!)!.cachedPromptTokensTotal).toBeUndefined();
  });
});
