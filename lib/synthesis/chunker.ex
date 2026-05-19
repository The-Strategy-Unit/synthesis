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

  @spec build_chunks([String.t()], non_neg_integer(), non_neg_integer()) :: [String.t()]
  defp build_chunks(sentences, chunk_size, overlap) do
    do_build(sentences, chunk_size, overlap, [], 0, [])
  end

  defp do_build([], _chunk_size, _overlap, current_rev, _current_bytes, acc) do
    case current_rev do
      [] -> Enum.reverse(acc)
      _ -> Enum.reverse([join_reversed(current_rev) | acc])
    end
  end

  defp do_build([sentence | rest], chunk_size, overlap, current_rev, current_bytes, acc) do
    added_bytes = sentence_joined_bytes(sentence, current_rev == [])
    candidate_rev = [sentence | current_rev]
    candidate_bytes = current_bytes + added_bytes

    if estimate_tokens_from_bytes(candidate_bytes) >= chunk_size do
      chunk = join_reversed(candidate_rev)
      {tail_rev, tail_bytes} = overlap_sentences(candidate_rev, overlap)
      do_build(rest, chunk_size, overlap, tail_rev, tail_bytes, [chunk | acc])
    else
      do_build(rest, chunk_size, overlap, candidate_rev, candidate_bytes, acc)
    end
  end

  # Take sentences from the end of the current chunk to seed the next one,
  # accumulating until we reach the overlap token budget.
  @spec overlap_sentences([String.t()], non_neg_integer()) :: {[String.t()], non_neg_integer()}
  defp overlap_sentences(sentences_rev, overlap_tokens) do
    sentences_rev
    |> Enum.reduce_while({[], 0}, fn s, {tail_in_order, bytes} ->
      added_bytes = sentence_joined_bytes(s, tail_in_order == [])
      next_tail_in_order = [s | tail_in_order]
      next_bytes = bytes + added_bytes

      if estimate_tokens_from_bytes(next_bytes) >= overlap_tokens do
        {:halt, {Enum.reverse(next_tail_in_order), next_bytes}}
      else
        {:cont, {next_tail_in_order, next_bytes}}
      end
    end)
  end

  @spec estimate_tokens_from_bytes(non_neg_integer()) :: non_neg_integer()
  defp estimate_tokens_from_bytes(bytes), do: div(bytes, 4)

  @spec sentence_joined_bytes(String.t(), boolean()) :: non_neg_integer()
  defp sentence_joined_bytes(sentence, true), do: byte_size(sentence)
  defp sentence_joined_bytes(sentence, false), do: byte_size(sentence) + 1

  @spec join_reversed([String.t()]) :: String.t()
  defp join_reversed(sentences_rev), do: sentences_rev |> Enum.reverse() |> Enum.join(" ")
end
