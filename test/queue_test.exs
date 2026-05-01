defmodule Synthesis.QueueTest do
  use ExUnit.Case, async: false
  import Mox

  alias Synthesis.Queue

  setup :verify_on_exit!

  setup do
    start_supervised!(Queue)
    :ok
  end

  # 1. Enqueuing
  test "job appears in state after enqueue" do
    Queue.enqueue("abc123", "some transcript")
    assert {:ok, job} = Queue.job("abc123")
    assert job.video_id == "abc123"
  end

  # 2. Job inspection
  test "job/1 returns not_found for unknown video_id" do
    assert {:error, :not_found} = Queue.job("nonexistent")
  end

  # 3. Status transitions
  test "job transitions to done on success" do
    Synthesis.MockExtractor
    |> expect(:extract, fn _t -> {:ok, %{summary: "s", insights: []}} end)

    Synthesis.MockFetcher
    |> expect(:fetch, fn _url -> {:ok, "transcript"} end)

    Queue.enqueue("abc123", "transcript")
    Process.sleep(500)
    assert {:error, :not_found} = Queue.job("abc123")
  end

  # 4. Failure handling
  test "job transitions to failed on extractor error" do
    Synthesis.MockExtractor
    |> expect(:extract, 3, fn _t -> {:error, "Ollama failed"} end)

    Queue.enqueue("abc123", "transcript")
    Process.sleep(1000)
    assert {:error, :not_found} = Queue.job("abc123")
  end
end
