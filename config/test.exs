import Config

config :synthesis,
  extractor: Synthesis.MockExtractor,
  writer: Synthesis.MockWriter,
  db_path: ":memory:"
