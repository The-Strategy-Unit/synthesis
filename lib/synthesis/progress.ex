defmodule Synthesis.Progress do
  @moduledoc "Minimal ANSI progress bar for CLI pipelines."

  def render(current, total, label \\ "") do
    width = 30
    filled = round(width * current / total)
    bar = String.duplicate("█", filled) <> String.duplicate("░", width - filled)
    pct = round(100 * current / total)
    IO.write("\r#{label} [#{bar}] #{pct}% (#{current}/#{total})")
    if current == total, do: IO.write("\n")
  end
end
