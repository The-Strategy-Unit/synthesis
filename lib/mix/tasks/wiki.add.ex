defmodule Mix.Tasks.Wiki.Add do
  @shortdoc "Fetch and process a YouTube URL into the knowledge base"
  use Mix.Task
  alias Synthesis.Fetcher

  @impl Mix.Task
  def run([url]) do
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

    Synthesis.process(urls)
  end

  def run(_), do: Mix.raise("Usage: mix wiki.add <youtube_url>")
end
