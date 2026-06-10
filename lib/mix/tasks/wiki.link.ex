defmodule Mix.Tasks.Wiki.Link do
  @shortdoc "Cross-link all existing zettels across domains"

  @moduledoc """
  Cross-link all zettels by semantic similarity, appending a ## Related
  section to each zettel markdown file.

  Usage:
    mix wiki.link [threshold]

  Options:
    threshold   Cosine distance threshold, 0.0–2.0 (default: from config).
                Lower values = stricter matching.

  Examples:
    mix wiki.link
    mix wiki.link 0.2
  """
  use Mix.Task

  defp valid_threshold!(t) when t >= 0.0 and t <= 2.0, do: t
  defp valid_threshold!(_), do: raise(ArgumentError, "threshold must be in [0, 2]")

  @impl Mix.Task
  def run(args) do
    t =
      case List.first(args) do
        nil ->
          Application.fetch_env!(:synthesis, :cross_link_threshold)

        raw ->
          case Float.parse(raw) do
            {t, ""} -> t
            _ -> raise ArgumentError, "threshold must be a float in [0, 2]"
          end
      end

    threshold = valid_threshold!(t)
    Mix.Task.run("app.start")
    {:ok, zettels} = Synthesis.Store.all_zettels()

    all_ids = Enum.map(zettels, & &1.id)

    Synthesis.Linker.link_zettels(all_ids, threshold)
    |> case do
      :ok -> IO.puts("Done.")
      {:error, reason} -> Mix.raise("Cross-linking failed: #{inspect(reason)}")
    end
  end
end
