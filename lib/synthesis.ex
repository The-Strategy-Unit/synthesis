defmodule Synthesis do
  @moduledoc """
  Top-level API for Synthesis. Orchestrates parallel fetching and sequential LLM processing.
  """

  alias Synthesis.{Fetcher, Queue, Utils}

  @spec process(String.t() | [String.t()], String.t()) :: :ok
  def process(url_or_urls, domain \\ "general")

  def process(url, domain) when is_binary(url), do: process([url], domain)

  def process(urls, domain) when is_list(urls) do
    urls
    |> Enum.map(fn url ->
      Task.async(fn ->
        video_id = Utils.extract_video_id(url)

        case Fetcher.fetch(url) do
          {:ok, {title, transcript}} ->
            Queue.enqueue(video_id, url, title, transcript, domain)
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
