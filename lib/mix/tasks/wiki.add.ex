defmodule Mix.Tasks.Wiki.Add do
  @shortdoc "Fetch and process a YouTube URL into the knowledge base"
  use Mix.Task

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.start")
    Synthesis.CLI.run(args)
  end
end
