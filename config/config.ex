import Config

config :synthesis,
  ollama_url: "http://localhost:11434",
  ollama_model: "gemma4:31b",
  max_retries: 3,
  output_dir: "output"

import_config "#{config_env()}.exs"
