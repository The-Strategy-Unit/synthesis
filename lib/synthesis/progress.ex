defmodule Synthesis.Progress do
  @moduledoc "ANSI progress bar and stage output, aware of quiet/verbose modes."

  alias Synthesis.Output

  def stage(label) do
    Output.puts(label)
  end

  def render(current, total, label \\ "") do
    width = 30
    filled = round(width * current / total)
    bar = String.duplicate("█", filled) <> String.duplicate("░", width - filled)
    pct = round(100 * current / total)
    Output.write("\r#{label} [#{bar}] #{pct}% (#{current}/#{total})")
    if current == total, do: Output.write("\n")
  end
end
