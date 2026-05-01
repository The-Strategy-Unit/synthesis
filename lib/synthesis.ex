defmodule Synthesis do
  @moduledoc """
  Top-level API for Synthesis. Orchestrates parallel fetching and sequential LLM processing.
  """

  alias Synthesis.{Fetcher, Queue}

  @spec process(String.t()) :: :ok
  def process(url) when is_binary(url), do: process([url])

  @spec process([String.t()]) :: :ok
  def process(urls) when is_list(urls) do
    urls
    |> Enum.map(fn url ->
      Task.async(fn ->
        video_id = extract_video_id(url)

        case Fetcher.fetch(url) do
          {:ok, transcript} ->
            Queue.enqueue(video_id, transcript)

          {:error, reason} ->
            IO.warn("Failed to fetch #{url}: #{reason}")
        end
      end)
    end)
    |> Task.await_many(:infinity)

    :ok
  end

  @spec jobs() :: map()
  defdelegate jobs(), to: Queue

  @spec job(String.t()) :: {:ok, map()} | {:error, :not_found}
  defdelegate job(video_id), to: Queue

  # Duplicated here to avoid coupling Queue to Fetcher internals
  @spec extract_video_id(String.t()) :: String.t()
  defp extract_video_id(url) do
    uri = URI.parse(url)

    cond do
      uri.query ->
        uri.query |> URI.decode_query() |> Map.get("v", "unknown")

      uri.host == "youtu.be" ->
        uri.path |> String.trim_leading("/")

      true ->
        "unknown"
    end
  end
end
