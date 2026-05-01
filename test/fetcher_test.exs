defmodule Synthesis.FetcherTest do
  use ExUnit.Case, async: true
  import Mox

  setup :verify_on_exit!

  test "enqueues transcript on successful fetch" do
    Synthesis.MockFetcher
    |> expect(:fetch, fn _url -> {:ok, "some transcript text"} end)

    assert {:ok, transcript} =
             Synthesis.MockFetcher.fetch("https://www.youtube.com/watch?v=abc123")

    assert transcript == "some transcript text"
  end

  test "returns error when fetch fails" do
    Synthesis.MockFetcher
    |> expect(:fetch, fn _url -> {:error, "yt-dlp failed"} end)

    assert {:error, reason} =
             Synthesis.MockFetcher.fetch("https://www.youtube.com/watch?v=abc123")

    assert reason == "yt-dlp failed"
  end
end
