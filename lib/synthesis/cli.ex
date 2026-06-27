defmodule Synthesis.CLI do
  @moduledoc """
  CLI entrypoint. Accepts one or more YouTube URLs as arguments.
  Supports optional --concurrency N flag (falls back to config.exs).
  Supports optional --model <model> flag (falls back to config.exs).
  """

  alias Synthesis.Fetcher

  @spec run([String.t()]) :: :ok | {:error, String.t()}
  def run([]) do
    {:error, "Usage: synthesis [--concurrency N] [--model <model>] <url> [url ...]"}
  end

  def run(args) do
    case parse_args(args) do
      {_, _, []} ->
        {:error, "Usage: synthesis [--concurrency N] <url> [url ...]"}

      {concurrency, domain, urls} ->
        if concurrency do
          Application.put_env(:synthesis, :chunk_concurrency, concurrency)
        end

        IO.puts(
          "Processing #{length(urls)} URL(s) [concurrency: #{effective_concurrency()}, model: #{effective_model()}]..."
        )

        urls =
          Enum.flat_map(urls, fn url ->
            if Fetcher.playlist?(url) do
              {:ok, expanded} = Fetcher.expand_playlist(url)
              expanded
            else
              [url]
            end
          end)

        Synthesis.process(urls, domain)

        :ok = wait_until_done()
    end
  end

  def main(args) do
    {:ok, _} = Application.ensure_all_started(:synthesis)

    case run(args) do
      {:error, reason} ->
        IO.puts(reason)
        System.halt(1)

      :ok ->
        :ok
    end
  end

  # --- Private ---

  defp parse_args(args) do
    {opts, urls, invalid} =
      OptionParser.parse(args,
        strict: [
          concurrency: :integer,
          domain: :string,
          model: :string,
          quiet: :boolean,
          verbose: :boolean
        ]
      )

    if invalid != [],
      do:
        (
          IO.puts("Unknown flags: #{inspect(invalid)}")
          System.halt(1)
        )

    concurrency = Keyword.get(opts, :concurrency)

    if concurrency && concurrency <= 0 do
      IO.puts("--concurrency must be a positive integer")
      System.halt(1)
    end

    model = Keyword.get(opts, :model)
    if model, do: Application.put_env(:synthesis, :ollama_model, model)

    quiet = Keyword.get(opts, :quiet, false)
    verbose = Keyword.get(opts, :verbose, false)

    if quiet && verbose do
      IO.puts("--quiet and --verbose cannot be used together")
      System.halt(1)
    end

    Application.put_env(:synthesis, :quiet, quiet)
    Application.put_env(:synthesis, :verbose, verbose)

    domain = Keyword.get(opts, :domain, "general")
    {concurrency, domain, urls}
  end

  defp effective_concurrency do
    Application.get_env(:synthesis, :chunk_concurrency, 2)
  end

  defp effective_model do
    Application.get_env(:synthesis, :ollama_model)
  end

  @spec wait_until_done() :: :ok
  defp wait_until_done do
    jobs = Synthesis.Queue.jobs()

    if Enum.all?(jobs, fn {_, j} -> j.status in [:done, :failed] end) do
      summary(jobs)
    else
      Process.sleep(500)
      wait_until_done()
    end
  end

  @spec summary(map()) :: :ok
  defp summary(jobs) do
    IO.puts("\n--- Results ---")

    Enum.each(jobs, fn {id, job} ->
      label = if(job.title, do: "#{id} - #{job.title}", else: id)

      case job.status do
        :done -> IO.puts("✓ #{label}")
        :failed -> IO.puts("✗ #{label} - #{job.error}")
        _ -> :ok
      end
    end)
  end
end
