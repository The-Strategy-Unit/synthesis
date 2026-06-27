defmodule Synthesis.Output do
  @moduledoc "Quiet/verbose-aware output helpers."

  @spec mode() :: :quiet | :normal | :verbose
  def mode do
    cond do
      Application.get_env(:synthesis, :quiet, false) -> :quiet
      Application.get_env(:synthesis, :verbose, false) -> :verbose
      true -> :normal
    end
  end

  @spec puts(String.t()) :: :ok
  def puts(text) do
    if mode() != :quiet, do: IO.puts(text)
    :ok
  end

  @spec write(String.t()) :: :ok
  def write(text) do
    if mode() != :quiet, do: IO.write(text)
    :ok
  end

  @spec debug(String.t()) :: :ok
  def debug(text) do
    if mode() == :verbose, do: IO.puts("[debug] #{text}")
    :ok
  end
end
