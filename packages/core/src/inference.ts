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
  /**
   * Prometheus histogram base names, without the `_sum`/`_count` suffix.
   *
   * Averages come from the *delta* of sum over the delta of count between two
   * scrapes, which gives the mean over that interval. Reading `_sum/_count`
   * directly would give the mean since the server booted — a number that barely
   * moves once a few thousand requests have gone through, and which says
   * nothing about how it is behaving now.
   */
  latency: {
    /** Time to first token. */
    ttft: string[];
    /** Inter-token latency, i.e. time per output token during decode. */
    interToken: string[];
    /** End-to-end request latency. */
    e2e: string[];
    /** Time spent queued before work began. */
    queue: string[];
    /** Prefill phase duration, per request. */
    prefill: string[];
    /** Decode phase duration, per request. */
    decode: string[];
  };
  /** Prompt tokens served from the prefix cache rather than computed. */
  cachedPromptTokens: string[];
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
    latency: {
      ttft: ["vllm:time_to_first_token_seconds"],
      interToken: ["vllm:inter_token_latency_seconds", "vllm:time_per_output_token_seconds"],
      e2e: ["vllm:e2e_request_latency_seconds"],
      queue: ["vllm:request_queue_time_seconds"],
      prefill: ["vllm:request_prefill_time_seconds"],
      decode: ["vllm:request_decode_time_seconds"],
    },
    cachedPromptTokens: ["vllm:prompt_tokens_cached_total"],
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
    latency: {
      ttft: ["sglang:time_to_first_token_seconds"],
      interToken: ["sglang:inter_token_latency_seconds", "sglang:time_per_output_token_seconds"],
      e2e: ["sglang:e2e_request_latency_seconds"],
      queue: ["sglang:queue_time_seconds"],
      prefill: [],
      decode: [],
    },
    cachedPromptTokens: ["sglang:cached_tokens_total"],
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
    latency: {
      ttft: [],
      interToken: [],
      e2e: [],
      queue: [],
      prefill: [],
      decode: [],
    },
    cachedPromptTokens: [],
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
    latency: {
      ttft: [],
      interToken: ["tgi_request_mean_time_per_token_duration"],
      e2e: ["tgi_request_duration"],
      queue: ["tgi_request_queue_duration"],
      prefill: ["tgi_request_inference_duration"],
      decode: [],
    },
    cachedPromptTokens: [],
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
    latency: {
      ttft: [],
      interToken: [],
      e2e: ["nv_inference_request_duration_us"],
      queue: ["nv_inference_queue_duration_us"],
      prefill: [],
      decode: [],
    },
    cachedPromptTokens: [],
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

/** Cumulative `_sum` and `_count` of one histogram. */
export interface HistogramTotals {
  sum: number;
  count: number;
}

export type LatencyKey = "ttft" | "interToken" | "e2e" | "queue" | "prefill" | "decode";

export interface EngineReading {
  engine: EngineId;
  engineLabel: string;
  models: string[];
  requestsRunning?: number;
  requestsWaiting?: number;
  requestsFinishedTotal?: number;
  promptTokensTotal?: number;
  generationTokensTotal?: number;
  /** Prompt tokens served from cache rather than computed. */
  cachedPromptTokensTotal?: number;
  kvCachePct?: number;
  /** Raw histogram totals, for deriving interval means against a prior scrape. */
  latency: Partial<Record<LatencyKey, HistogramTotals>>;
}

/** Read a histogram's cumulative sum and count, trying each candidate name. */
function readHistogram(samples: Map<string, PromSample[]>, names: string[]): HistogramTotals | undefined {
  for (const n of names) {
    const sum = sumMetric(samples, [`${n}_sum`]);
    const count = sumMetric(samples, [`${n}_count`]);
    if (sum !== undefined && count !== undefined) return { sum, count };
  }
  return undefined;
}

/**
 * Mean of a histogram over the interval between two scrapes.
 *
 * `(sum_now - sum_before) / (count_now - count_before)`. Dividing the raw
 * totals instead yields the mean since the process started, which on a server
 * that has handled thousands of requests is dominated by history and barely
 * responds to what is happening now.
 *
 * Returns null when nothing completed in the interval — there is no average of
 * zero samples, and reporting 0ms would read as "instant" rather than "idle".
 */
export function histogramIntervalMean(
  prev: HistogramTotals | undefined,
  now: HistogramTotals | undefined
): number | null {
  if (!prev || !now) return null;
  const dCount = now.count - prev.count;
  const dSum = now.sum - prev.sum;
  // A counter reset (server restart) shows as negative; treat as no data.
  if (dCount <= 0 || dSum < 0) return null;
  return dSum / dCount;
}

/** Lifetime mean, used as a fallback before a second scrape exists. */
export function histogramLifetimeMean(h: HistogramTotals | undefined): number | null {
  if (!h || h.count <= 0) return null;
  return h.sum / h.count;
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
    latency: {},
  };
  for (const key of ["ttft", "interToken", "e2e", "queue", "prefill", "decode"] as const) {
    const h = readHistogram(samples, spec.latency[key]);
    if (h) reading.latency[key] = h;
  }
  const set = <K extends keyof EngineReading>(k: K, v: EngineReading[K]) => {
    if (v !== undefined && Number.isFinite(v as number)) reading[k] = v;
  };
  set("requestsRunning", sumMetric(samples, spec.running));
  set("requestsWaiting", sumMetric(samples, spec.waiting));
  set("requestsFinishedTotal", sumMetric(samples, spec.finished));
  set("promptTokensTotal", sumMetric(samples, spec.promptTokens));
  set("generationTokensTotal", sumMetric(samples, spec.genTokens));
  set("cachedPromptTokensTotal", sumMetric(samples, spec.cachedPromptTokens));
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
      latency: {},
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
