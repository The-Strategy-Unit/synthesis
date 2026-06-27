defmodule Mix.Tasks.Wiki.Urls do
  @shortdoc "List processed YouTube URLs"
  use Mix.Task

  alias Synthesis.Store

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: [domain: :string])
    domain = Keyword.get(opts, :domain)

    Mix.Task.run("app.start")

    case Store.list_episode_urls(domain) do
      {:ok, []} ->
        IO.puts("No URLs found.")

      {:ok, episodes} ->
        Enum.each(episodes, fn %{url: url, title: title} ->
          IO.puts("#{url}\t#{title || "(no title)"}")
        end)

      {:error, reason} ->
        Mix.raise("Failed to list URLs: #{inspect(reason)}")
    end
  end
end
