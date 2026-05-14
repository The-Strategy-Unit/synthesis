defmodule Synthesis do
  @moduledoc """
  Top-level API for Synthesis. Orchestrates parallel fetching and sequential LLM processing.
  """

  alias Synthesis.{Fetcher, Queue, Utils}

  @spec process(String.t()) :: :ok
  def process(url) when is_binary(url), do: process([url])

  @spec process([String.t()]) :: :ok
  def process(urls) when is_list(urls) do
    urls
    |> Enum.map(fn url ->
      Task.async(fn ->
        video_id = Utils.extract_video_id(url)

        case Fetcher.fetch(url) do
          {:ok, {title, transcript}} ->
            Queue.enqueue(video_id, url, title, transcript)
            Queue.await(video_id)

          {:error, reason} ->
            IO.warn("Failed to fetch #{url}: #{reason}")
        end
      end)
    end)
    |> Task.await_many(:infinity)

    :ok
  end
end
