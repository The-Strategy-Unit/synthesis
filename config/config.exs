import Config

config :synthesis,
  ollama_url: "http://localhost:11434",
  ollama_model: "qwen3.6:27b",
  ollama_model_embed: "qwen3-embedding:8b",
  max_retries: 3,
  temperature: 0.1,
  output_dir: "output",
  db_path: "synthesis.db"

import_config "#{config_env()}.exs"
