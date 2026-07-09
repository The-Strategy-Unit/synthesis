defmodule Mix.Tasks.Wiki.Dedup do
  @shortdoc "Deduplicate semantically similar zettels across episodes"
  use Mix.Task

  @impl Mix.Task
  def run(_args) do
    Mix.Task.run("app.start")
    {:ok, count} = Synthesis.Deduplicator.run()
    IO.puts("Deduplicated #{count} zettel(s).")
  end
end
