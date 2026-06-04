defmodule Mix.Tasks.Wiki.Link do
  @shortdoc "Cross-link all existing zettels across domains"
  use Mix.Task
  @impl Mix.Task
  def run(_args) do
    Mix.Task.run("app.start")
    {:ok, zettels} = Synthesis.Store.all_zettels()

    zettels
    |> Enum.group_by(& &1.domain)
    |> Enum.each(fn {domain, zs} ->
      Synthesis.Linker.link_zettels(Enum.map(zs, & &1.id), domain)
    end)

    IO.puts("Done.")
  end
end
