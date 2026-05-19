defmodule Mix.Tasks.Wiki.Add do
  @shortdoc "Fetch and process a YouTube URL into the knowledge base"
  use Mix.Task
  alias Synthesis.Fetcher

  @impl Mix.Task
  def run(args) do
    {opts, positional, _} = OptionParser.parse(args, strict: [domain: :string])
    domain = Keyword.get(opts, :domain, "general")

    url =
      case positional do
        [url] -> url
        _ -> Mix.raise("Usage: mix wiki.add <youtube_url> [--domain <name>]")
      end

    Mix.Task.run("app.start")

    urls =
      if Fetcher.playlist?(url) do
        case Fetcher.expand_playlist(url) do
          {:ok, urls} ->
            IO.puts("Playlist detected — #{length(urls)} videos found.")
            urls

          {:error, reason} ->
            Mix.raise("Playlist expansion failed: #{reason}")
        end
      else
        [url]
      end

    Synthesis.process(urls, domain)
  end
end
