/**
 * Inference server detection and metrics.
 *
 * Rather than special-casing one runtime, sparktop probes whatever is listening
 * on a node and identifies it from what it answers with. Every serious engine
 * exposes Prometheus text on /metrics with its own metric prefix, which makes
 * both detection and scraping a single request — and the ones that do not
 * (Ollama) are recognised from their JSON API instead.
 *
 * Counter semantics differ per engine but the shapes do not: some number of
 * requests in flight, some queued, cumulative prompt and generated tokens.
 * Those are normalised here so the UI never needs to know which engine it is
 * looking at, and token rates are derived from the cumulative counters the same
 * way fabric throughput is — deltas over measured wall time.
 */

export type EngineId =
  | "vllm"
  | "sglang"
  | "llamacpp"
  | "tgi"
  | "triton"
  | "ollama"
  | "openai"
  | "unknown";

export interface EngineSpec {
  id: EngineId;
  label: string;
  /** Matches metric names in /metrics output; first hit wins. */
  signature: RegExp;
  /** Metric names, tried in order. Values are summed across label sets. */
  running: string[];
  waiting: string[];
  promptTokens: string[];
  genTokens: string[];
  /** Cumulative completed requests. */
  finished: string[];
  /** KV cache utilisation. */
  kvCache: string[];
  /** Multiplier to bring kvCache onto a 0-100 scale. */
  kvCacheScale: number;
}

/**
 * Metric names per engine.
 *
 * Several are listed per slot because names drift between releases — vLLM
 * renamed gpu_cache_usage_perc to kv_cache_usage_perc, for instance — and
 * falling through a list is cheaper than pinning a version.
 */
export const ENGINE_SPECS: EngineSpec[] = [
  {
    id: "vllm",
    label: "vLLM",
    signature: /^vllm:/m,
    running: ["vllm:num_requests_running"],
    waiting: ["vllm:num_requests_waiting"],
    promptTokens: ["vllm:prompt_tokens_total"],
    genTokens: ["vllm:generation_tokens_total"],
    finished: ["vllm:request_success_total"],
    kvCache: ["vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc"],
    kvCacheScale: 100,
  },
  {
    id: "sglang",
    label: "SGLang",
    signature: /^sglang:/m,
    running: ["sglang:num_running_reqs"],
    waiting: ["sglang:num_queue_reqs"],
    promptTokens: ["sglang:prompt_tokens_total"],
    genTokens: ["sglang:generation_tokens_total"],
    finished: ["sglang:num_requests_total"],
    kvCache: ["sglang:token_usage"],
    kvCacheScale: 100,
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    signature: /^llamacpp:/m,
    running: ["llamacpp:requests_processing"],
    waiting: ["llamacpp:requests_deferred"],
    promptTokens: ["llamacpp:prompt_tokens_total"],
    genTokens: ["llamacpp:tokens_predicted_total"],
    finished: [],
    kvCache: ["llamacpp:kv_cache_usage_ratio"],
    kvCacheScale: 100,
  },
  {
    id: "tgi",
    label: "TGI",
    signature: /^tgi_/m,
    running: ["tgi_batch_current_size"],
    waiting: ["tgi_queue_size"],
    promptTokens: ["tgi_request_input_length_sum"],
    genTokens: ["tgi_request_generated_tokens_sum"],
    finished: ["tgi_request_success"],
    kvCache: [],
    kvCacheScale: 100,
  },
  {
    id: "triton",
    label: "Triton",
    signature: /^nv_inference_/m,
    running: ["nv_inference_pending_request_count"],
    waiting: [],
    promptTokens: [],
    genTokens: [],
    finished: ["nv_inference_request_success"],
    kvCache: ["nv_trt_llm_kv_cache_block_metrics"],
    kvCacheScale: 100,
  },
];

/** A single Prometheus sample. */
export interface PromSample {
  labels: Record<string, string>;
  value: number;
}

/**
 * Parse Prometheus text exposition into `name -> samples`.
 *
 * Deliberately tolerant: comments, HELP/TYPE lines, NaN and exponent notation
 * all appear in real output and none of them should abort a scrape.
 */
export function parsePrometheus(text: string): Map<string, PromSample[]> {
  const out = new Map<string, PromSample[]>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const braceStart = line.indexOf("{");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;

    if (braceStart !== -1) {
      const braceEnd = line.lastIndexOf("}");
      if (braceEnd === -1) continue;
      name = line.slice(0, braceStart);
      labels = parseLabels(line.slice(braceStart + 1, braceEnd));
      rest = line.slice(braceEnd + 1);
    } else {
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp);
    }

    const value = Number(rest.trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    const list = out.get(name);
    if (list) list.push({ labels, value });
    else out.set(name, [{ labels, value }]);
  }
  return out;
}

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Values may contain commas and escaped quotes, so scan rather than split.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) out[m[1]] = (m[2] ?? "").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

/** Sum a metric across every label combination, trying each candidate name. */
function sumMetric(samples: Map<string, PromSample[]>, names: string[]): number | undefined {
  for (const n of names) {
    const list = samples.get(n);
    if (list?.length) return list.reduce((a, s) => a + s.value, 0);
  }
  return undefined;
}

/** Take the highest value, for gauges that are per-engine rather than additive. */
function maxMetric(samples: Map<string, PromSample[]>, names: string[]): number | undefined {
  for (const n of names) {
    const list = samples.get(n);
    if (list?.length) return Math.max(...list.map((s) => s.value));
  }
  return undefined;
}

export function detectEngine(metricsText: string): EngineSpec | null {
  return ENGINE_SPECS.find((s) => s.signature.test(metricsText)) ?? null;
}

/** Model names advertised in metric labels, which most engines attach. */
export function modelsFromSamples(samples: Map<string, PromSample[]>): string[] {
  const found = new Set<string>();
  for (const list of samples.values()) {
    for (const s of list) {
      const m = s.labels.model_name ?? s.labels.model ?? s.labels.engine_model;
      if (m) found.add(m);
    }
  }
  return [...found];
}

export interface EngineReading {
  engine: EngineId;
  engineLabel: string;
  models: string[];
  requestsRunning?: number;
  requestsWaiting?: number;
  requestsFinishedTotal?: number;
  promptTokensTotal?: number;
  generationTokensTotal?: number;
  kvCachePct?: number;
}

/** Turn a scraped /metrics body into engine-neutral numbers. */
export function readMetrics(metricsText: string): EngineReading | null {
  const spec = detectEngine(metricsText);
  if (!spec) return null;
  const samples = parsePrometheus(metricsText);
  const kv = maxMetric(samples, spec.kvCache);
  const reading: EngineReading = {
    engine: spec.id,
    engineLabel: spec.label,
    models: modelsFromSamples(samples),
  };
  const set = <K extends keyof EngineReading>(k: K, v: EngineReading[K]) => {
    if (v !== undefined && Number.isFinite(v as number)) reading[k] = v;
  };
  set("requestsRunning", sumMetric(samples, spec.running));
  set("requestsWaiting", sumMetric(samples, spec.waiting));
  set("requestsFinishedTotal", sumMetric(samples, spec.finished));
  set("promptTokensTotal", sumMetric(samples, spec.promptTokens));
  set("generationTokensTotal", sumMetric(samples, spec.genTokens));
  if (kv !== undefined) {
    // Engines report either a 0-1 ratio or an already-scaled percentage.
    set("kvCachePct", kv <= 1.0001 ? kv * spec.kvCacheScale : kv);
  }
  return reading;
}

/**
 * Ollama has no Prometheus endpoint; `/api/ps` lists loaded models instead.
 * Detected separately so it still appears, with request counts simply absent.
 */
export function readOllama(psJson: string): EngineReading | null {
  try {
    const parsed = JSON.parse(psJson) as { models?: { name?: string; model?: string }[] };
    if (!parsed || !Array.isArray(parsed.models)) return null;
    return {
      engine: "ollama",
      engineLabel: "Ollama",
      models: parsed.models.map((m) => m.name ?? m.model ?? "").filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** Model ids from an OpenAI-compatible /v1/models response. */
export function readOpenAiModels(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { data?: { id?: string }[] };
    return (parsed.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ports never worth probing: SSH, DNS, printing, and sparktop itself. Keeping
 * this small matters because every entry is a request per discovery cycle.
 */
export const SKIP_PORTS = new Set([22, 25, 53, 123, 631, 5757, 5432, 3306, 6379, 9090, 111, 2049]);
