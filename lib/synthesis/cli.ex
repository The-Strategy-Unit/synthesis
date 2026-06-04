defmodule Synthesis.CLI do
  @moduledoc """
  CLI entrypoint. Accepts one or more YouTube URLs as arguments.
  Supports optional --concurrency N flag (falls back to config.exs).
  """

  @spec run([String.t()]) :: :ok | {:error, String.t()}
  def run([]) do
    {:error, "Usage: synthesis [--concurrency N] <url> [url ...]"}
  end

  def run(args) do
    case parse_args(args) do
      {_, []} ->
        {:error, "Usage: synthesis [--concurrency N] <url> [url ...]"}

      {concurrency, urls} ->
        if concurrency do
          Application.put_env(:synthesis, :chunk_concurrency, concurrency)
        end

        IO.puts("Processing #{length(urls)} URL(s) [concurrency: #{effective_concurrency()}]...")
        Synthesis.process(urls)
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
      OptionParser.parse(args, strict: [concurrency: :integer, domain: :string])

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

    {concurrency, urls}
  end

  defp effective_concurrency do
    Application.get_env(:synthesis, :chunk_concurrency, 2)
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
      case job.status do
        :done -> IO.puts("✓ #{id}")
        :failed -> IO.puts("✗ #{id} — #{job.error}")
        _ -> :ok
      end
    end)
  end
end
