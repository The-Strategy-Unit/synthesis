defmodule Mix.Tasks.Wiki.Domains do
  @shortdoc "List all domains and their episode counts"
  use Mix.Task

  alias Synthesis.Store

  @impl Mix.Task
  def run(_args) do
    Mix.Task.run("app.start")

    case Store.list_domains() do
      {:ok, []} ->
        IO.puts("No domains found.")

      {:ok, domains} ->
        Enum.each(domains, fn {domain, count} ->
          IO.puts("#{String.pad_trailing(domain, 12)} #{count}")
        end)

      {:error, reason} ->
        Mix.raise("Failed to list domains: #{inspect(reason)}")
    end
  end
end
