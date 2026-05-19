defmodule Mix.Tasks.Wiki.Search do
  @shortdoc "Search the knowledge base by keyword and semantic similarity"
  use Mix.Task

  alias Synthesis.{Embedder, Store}

  @impl Mix.Task
  def run(args) do
    {opts, positional, _} =
      OptionParser.parse(args, strict: [domain: :string, all_domains: :boolean])

    query =
      case positional do
        [query] -> query
        _ -> Mix.raise("Usage: mix wiki.search <query> [--domain <name>] [--all-domains]")
      end

    domain =
      cond do
        Keyword.get(opts, :all_domains, false) -> nil
        true -> Keyword.get(opts, :domain, "general")
      end

    Mix.Task.run("app.start")

    IO.puts("\n=== Keyword Results ===\n")

    case Store.search_keyword(query, domain) do
      {:ok, []} -> IO.puts("No keyword matches found.")
      {:ok, results} -> results |> Enum.with_index(1) |> Enum.each(&print_keyword_result/1)
      {:error, reason} -> IO.warn("Keyword search failed: #{inspect(reason)}")
    end

    IO.puts("\n=== Semantic Results ===\n")

    with {:ok, vector} <- Embedder.embed_query(query),
         {:ok, results} <- Store.search_semantic(vector, domain) do
      case results do
        [] -> IO.puts("No semantic matches found.")
        _ -> results |> Enum.with_index(1) |> Enum.each(&print_semantic_result/1)
      end
    else
      {:error, reason} -> IO.warn("Semantic search failed: #{inspect(reason)}")
    end
  end

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
    score = round((1 - distance / 2) * 10)
    score = max(0, min(10, score))
    filled = String.duplicate("█", score)
    empty = String.duplicate("░", 10 - score)
    percent = round((1 - distance / 2) * 100)
    "#{filled}#{empty} #{percent}%"
  end
end
