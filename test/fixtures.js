// Response bodies captured from, or shaped like, real servers.
//
// The vLLM body is verbatim from a live node, trimmed to the series the plugin
// filters for -- two engines' worth on purpose, because vLLM emits one series
// per engine and the sum is what matters. The rest are shaped from each
// project's own documented metric names.

// Captured verbatim from a live vLLM node (DGX Spark), trimmed to the series
// the plugin actually filters for. Two engines' worth of series are present on
// purpose: vLLM emits one per engine/model and the sum is what matters.
const VLLM = [
  '# HELP vllm:generation_tokens_total Number of generation tokens processed.',
  '# TYPE vllm:generation_tokens_total counter',
  'vllm:generation_tokens_total{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 48456.0',
  'vllm:generation_tokens_total{engine="1",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 12000.0',
  'vllm:kv_cache_usage_perc{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.4',
  'vllm:kv_cache_usage_perc{engine="1",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.6',
  'vllm:num_requests_running{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.0',
  'vllm:num_requests_waiting{engine="0",model_name="Qwen/Qwen3.6-35B-A3B-FP8"} 0.0'
].join("\n")

const OLLAMA_PS = JSON.stringify({
  models: [{ name: "qwen3-embedding:0.6b", expires_at: "2026-08-25T23:04:54.790456934Z", size_vram: 2176054080 }]
})
const OLLAMA_PS_LATER = JSON.stringify({
  models: [{ name: "qwen3-embedding:0.6b", expires_at: "2026-08-25T23:05:33.189782316Z", size_vram: 2176054080 }]
})

// A body shaped like the real thing: the series the plugin needs sit far past
// any fixed byte bound, behind a wall of histogram buckets.
function bigMetricsBody() {
  const filler = []
  for (let i = 0; i < 400; i++) {
    filler.push(`# HELP vllm:inter_token_latency_seconds_bucket latency`)
    filler.push(`vllm:inter_token_latency_seconds_bucket{le="${i / 100}",model_name="m"} ${i}.0`)
  }
  return [
    "# HELP vllm:cache_config_info cache",
    'vllm:cache_config_info{block_size="16"} 1.0',
    ...filler,
    'vllm:num_requests_running{engine="0",model_name="m"} 3.0',
    'vllm:num_requests_waiting{engine="0",model_name="m"} 1.0',
    'vllm:generation_tokens_total{engine="0",model_name="m"} 987654.0'
  ].join("\n")
}

const BODIES = {
  llamacpp: [
    "# HELP llamacpp:tokens_predicted_total Number of generated tokens",
    "# TYPE llamacpp:tokens_predicted_total counter",
    "llamacpp:tokens_predicted_total 1250",
    "# TYPE llamacpp:requests_processing gauge",
    "llamacpp:requests_processing 2",
    "# TYPE llamacpp:requests_deferred gauge",
    "llamacpp:requests_deferred 1",
    "llamacpp:prompt_tokens_total 900"
  ].join("\n"),
  sglang: [
    "# TYPE sglang:generation_tokens_total counter",
    'sglang:generation_tokens_total{model_name="qwen"} 4400.0',
    'sglang:num_running_reqs{model_name="qwen"} 3.0',
    'sglang:num_queue_reqs{model_name="qwen"} 2.0',
    'sglang:cache_hit_rate{model_name="qwen"} 0.5'
  ].join("\n"),
  tgi: [
    "# TYPE tgi_request_generated_tokens histogram",
    'tgi_request_generated_tokens_bucket{le="1"} 0',
    "tgi_request_generated_tokens_sum 8123",
    "tgi_request_generated_tokens_count 44",
    "# TYPE tgi_batch_current_size gauge",
    "tgi_batch_current_size 4",
    "# TYPE tgi_queue_size gauge",
    "tgi_queue_size 7"
  ].join("\n")
}

module.exports = { VLLM, OLLAMA_PS, OLLAMA_PS_LATER, bigMetricsBody, BODIES }
