defmodule Mix.Tasks.Wiki.Add do
  @shortdoc "Fetch and process a YouTube URL into the knowledge base"

  @moduledoc """
  Fetch, transcribe and store a YouTube video or playlist as zettels.

  Usage:
    mix wiki.add <url> [url ...] [options]

  Options:
    --domain        Domain/category for the zettels (default: "general")
    --concurrency   Number of parallel workers (default: from config)

  Examples:
    mix wiki.add https://www.youtube.com/watch?v=<id>
    mix wiki.add https://www.youtube.com/playlist?list=<id> --domain elixir
  """
  use Mix.Task

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.start")
    Synthesis.CLI.run(args)
  end
end
