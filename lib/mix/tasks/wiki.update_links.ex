defmodule Mix.Tasks.Wiki.UpdateLinks do
  @shortdoc "Rewrite Related sections in all insight notes from the database"
  use Mix.Task

  @impl Mix.Task
  def run(_args) do
    Mix.Task.run("app.start")
    Synthesis.WikiUpdater.run()
    IO.puts("Wiki links updated.")
  end
end
