defmodule Mix.Tasks.Wiki.Add do
  @shortdoc "Fetch and process a YouTube URL into the knowledge base"
  use Mix.Task

  @impl Mix.Task
  def run([url]) do
    Mix.Task.run("app.start")
    Synthesis.process(url)
  end

  def run(_), do: Mix.raise("Usage: mix wiki.add <youtube_url>")
end
