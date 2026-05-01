defmodule Synthesis.CLI do
  @moduledoc """
  CLI entrypoint. Accepts one or more YouTube URLs as arguments.
  """

  @spec main([String.t()]) :: :ok
  def main([]) do
    IO.puts("Usage: synthesis <url> [url ...]")
    System.halt(1)
  end

  def main(urls) do
    {:ok, _} = Application.ensure_all_started(:synthesis)
    IO.puts("Processing #{length(urls)} URL(s)...")
    Synthesis.process(urls)
    wait_until_done()
  end

  @spec wait_until_done() :: :ok
  defp wait_until_done do
    jobs = Synthesis.jobs()

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
