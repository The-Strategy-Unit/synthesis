defmodule Synthesis.ExtractorTest do
  use ExUnit.Case, async: true
  import Mox

  setup :verify_on_exit!

  @transcript "there was a big pandemic in 1889 1890..."

  @valid_extraction %{
    summary: "A discussion about the 1918 flu and its transmission to pigs.",
    insights: [
      %{
        title: "Reverse Zoonosis in 1918",
        content: "The 1918 flu virus likely jumped from humans to pigs.",
        tags: ["flu", "zoonosis"],
        related: ["Antigenic Drift in Pigs"]
      }
    ]
  }

  test "returns structured extraction on success" do
    Synthesis.MockExtractor
    |> expect(:extract, fn _transcript -> {:ok, @valid_extraction} end)

    assert {:ok, result} = Synthesis.MockExtractor.extract(@transcript)
    assert result.summary =~ "1918 flu"
    assert length(result.insights) == 1
    assert hd(result.insights).title == "Reverse Zoonosis in 1918"
  end

  test "returns error on Ollama failure" do
    Synthesis.MockExtractor
    |> expect(:extract, fn _transcript -> {:error, "Ollama returned HTTP 500"} end)

    assert {:error, reason} = Synthesis.MockExtractor.extract(@transcript)
    assert reason =~ "500"
  end

  test "returns error when max retries exceeded" do
    Synthesis.MockExtractor
    |> expect(:extract, fn _transcript -> {:error, "Extraction failed after 3 attempts"} end)

    assert {:error, reason} = Synthesis.MockExtractor.extract(@transcript)
    assert reason =~ "3 attempts"
  end
end
