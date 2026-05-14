defmodule Mix.Tasks.Wiki.Search do
  @shortdoc "Search the knowledge base by keyword and semantic similarity"
  use Mix.Task

  alias Synthesis.{Embedder, Store}

  @impl Mix.Task
  def run([query]) do
    Mix.Task.run("app.start")

    IO.puts("\n=== Keyword Results ===\n")
    keyword_results = Store.search_keyword(query)

    case keyword_results do
      {:ok, []} ->
        IO.puts("No keyword matches found.")

      {:ok, results} ->
        results |> Enum.with_index(1) |> Enum.each(&print_keyword_result/1)

      {:error, reason} ->
        IO.warn("Keyword search failed: #{inspect(reason)}")
    end

    IO.puts("\n=== Semantic Results ===\n")

    with {:ok, vector} <- Embedder.embed_query(query),
         {:ok, results} <- Store.search_semantic(vector) do
      case results do
        [] -> IO.puts("No semantic matches found.")
        _ -> results |> Enum.with_index(1) |> Enum.each(&print_semantic_result/1)
      end
    else
      {:error, reason} -> IO.warn("Semantic search failed: #{inspect(reason)}")
    end
  end

  def run(_), do: Mix.raise("Usage: mix wiki.search <query>")

  defp print_keyword_result({result, idx}) do
    IO.puts("[#{idx}] #{result.insight}")
    IO.puts("    Source: #{result.episode_title}")
    IO.puts("    URL:    #{result.episode_url}")
    IO.puts("    Tags:   #{result.tags}")
    IO.puts("")
  end

  defp print_semantic_result({result, idx}) do
    IO.puts("[#{idx}] #{result.insight}")
    IO.puts("    Source:    #{result.episode_title}")
    IO.puts("    URL:       #{result.episode_url}")
    IO.puts("    Tags:      #{result.tags}")
    IO.puts("    Relevance: #{relevance_bar(result.distance)}")
    IO.puts("")
  end

  defp relevance_bar(distance) do
    # Cosine distance is in [0, 2]: defined as (1 - cosine_similarity),
    # where cosine similarity ranges from -1 (opposite) to +1 (identical).
    # Normalise to [0, 1] by dividing by 2 before converting to a percentage.
    score = round((1 - distance / 2) * 10)
    score = max(0, min(10, score))
    filled = String.duplicate("█", score)
    empty = String.duplicate("░", 10 - score)
    percent = round((1 - distance / 2) * 100)
    "#{filled}#{empty} #{percent}%"
  end
end
