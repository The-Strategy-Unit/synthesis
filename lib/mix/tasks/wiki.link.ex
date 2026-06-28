defmodule Mix.Tasks.Wiki.Link do
  @shortdoc "Cross-link all existing zettels"
  use Mix.Task

  @impl Mix.Task
  def run(_args) do
    Mix.Task.run("app.start")
    Synthesis.Linker.link_all()
    IO.puts("Done.")
  end
end
