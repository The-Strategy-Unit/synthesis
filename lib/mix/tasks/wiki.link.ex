defmodule Mix.Tasks.Wiki.Link do
  @shortdoc "Cross-link all existing zettels across domains"

  use Mix.Task

  defp valid_threshold!(t) when t >= 0.0 and t <= 2.0, do: t
  defp valid_threshold!(_), do: raise(ArgumentError, "threshold must be in [0, 2]")

  @impl Mix.Task
  def run(args) do
    t =
      args
      |> List.first()
      |> then(
        &if &1,
          do: String.to_float(&1),
          else: Application.fetch_env!(:synthesis, :cross_link_threshold)
      )

    threshold = valid_threshold!(t)
    Mix.Task.run("app.start")
    {:ok, zettels} = Synthesis.Store.all_zettels()

    zettels
    |> Enum.group_by(& &1.domain)
    |> Enum.each(fn {domain, zs} ->
      Synthesis.Linker.link_zettels(Enum.map(zs, & &1.id), domain, threshold)
    end)

    IO.puts("Done.")
  end
end
