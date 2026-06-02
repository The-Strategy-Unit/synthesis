defmodule Synthesis.CLI do
  @moduledoc """
  CLI entrypoint. Accepts one or more YouTube URLs as arguments.
  Supports optional --concurrency N flag (falls back to config.exs).
  """

  @spec main([String.t()]) :: :ok
  def main([]) do
    IO.puts("Usage: synthesis [--concurrency N] <url> [url ...]")
    System.halt(1)
  end

  def main(args) do
    {concurrency, urls} = parse_args(args)

    if concurrency do
      # Intentional: it mutates app env before the supervised tree starts, 
      # so Extractor picks it up naturally without any extra plumbing.
      Application.put_env(:synthesis, :chunk_concurrency, concurrency)
    end

    {:ok, _} = Application.ensure_all_started(:synthesis)
    IO.puts("Processing #{length(urls)} URL(s) [concurrency: #{effective_concurrency()}]...")
    Synthesis.process(urls)
    wait_until_done()
  end

  # --- Private ---

  defp parse_args(args) do
    case args do
      ["--concurrency", n_str | rest] ->
        case Integer.parse(n_str) do
          {n, ""} when n > 0 ->
            {n, rest}

          _ ->
            IO.puts("Invalid --concurrency value: #{n_str}")
            System.halt(1)
        end

      _ ->
        {nil, args}
    end
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
