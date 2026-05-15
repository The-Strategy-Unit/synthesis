import Config

config :synthesis,
  ollama_url: "http://localhost:11434",
  ollama_model: "qwen3.6:27b",
  ollama_model_embed: "qwen3-embedding:8b",
  max_retries: 3,
  # 20min
  receive_timeout: 1_200_000,
  temperature: 0.1,
  chunk_tokens: 2000,
  overlap_tokens: 200,
  # keep low - Ollama is single-threaded per request
  chunk_concurrency: 2,
  output_dir: "output",
  db_path: "synthesis.db"

import_config "#{config_env()}.exs"
