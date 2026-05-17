defmodule Synthesis.Chunker do
  @moduledoc """
  Splits a transcript into overlapping sentence-boundary chunks.

  Token count is approximated as byte_size(text) / 4, which is
  accurate enough for English podcast transcripts.

  Configuration (config/config.exs):
    config :synthesis,
      chunk_tokens:   2000,  # target tokens per chunk
      overlap_tokens: 200    # overlap between consecutive chunks
  """

  @spec chunk(String.t()) :: [String.t()]
  def chunk(text) do
    sentences = split_sentences(text)
    chunk_size = Application.get_env(:synthesis, :chunk_tokens, 2000)
    overlap = Application.get_env(:synthesis, :overlap_tokens, 200)
    build_chunks(sentences, chunk_size, overlap)
  end

  # --- Private ---

  @sentence_boundary ~r/(?<=[.?!])\s+/

  @spec split_sentences(String.t()) :: [String.t()]
  defp split_sentences(text) do
    text
    |> String.split(@sentence_boundary)
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  @spec estimate_tokens(String.t()) :: non_neg_integer()
  defp estimate_tokens(text), do: div(byte_size(text), 4)

  @spec build_chunks([String.t()], non_neg_integer(), non_neg_integer()) :: [String.t()]
  defp build_chunks(sentences, chunk_size, overlap) do
    do_build(sentences, chunk_size, overlap, [], [])
  end

  defp do_build([], _chunk_size, _overlap, current, acc) do
    case current do
      [] -> Enum.reverse(acc)
      _ -> Enum.reverse([join(current) | acc])
    end
  end

  defp do_build([sentence | rest], chunk_size, overlap, current, acc) do
    candidate = current ++ [sentence]

    if estimate_tokens(join(candidate)) >= chunk_size do
      chunk = join(candidate)
      tail = overlap_sentences(candidate, overlap)
      do_build(rest, chunk_size, overlap, tail, [chunk | acc])
    else
      do_build(rest, chunk_size, overlap, candidate, acc)
    end
  end

  # Take sentences from the end of the current chunk to seed the next one,
  # accumulating until we reach the overlap token budget.
  @spec overlap_sentences([String.t()], non_neg_integer()) :: [String.t()]
  defp overlap_sentences(sentences, overlap_tokens) do
    sentences
    |> Enum.reverse()
    |> Enum.reduce_while([], fn s, acc ->
      next = [s | acc]
      if estimate_tokens(join(next)) >= overlap_tokens, do: {:halt, next}, else: {:cont, next}
    end)
  end

  @spec join([String.t()]) :: String.t()
  defp join(sentences), do: Enum.join(sentences, " ")
end
