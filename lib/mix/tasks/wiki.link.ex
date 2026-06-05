defmodule Mix.Tasks.Wiki.Link do
  @shortdoc "Cross-link all existing zettels across domains"

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

    zettels
    |> Enum.group_by(& &1.domain)
    |> Enum.reduce_while(:ok, fn {domain, zs}, :ok ->
      case Synthesis.Linker.link_zettels(Enum.map(zs, & &1.id), domain, threshold) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      :ok -> IO.puts("Done.")
      {:error, reason} -> Mix.raise("Cross-linking failed: #{inspect(reason)}")
    end
  end
end
