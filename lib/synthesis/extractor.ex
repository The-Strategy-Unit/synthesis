defmodule Synthesis.ExtractorBehaviour do
  @callback extract(String.t()) :: {:ok, map()} | {:error, String.t()}
end

defmodule Synthesis.Extractor do
  @behaviour Synthesis.ExtractorBehaviour
  @moduledoc """
  Sends transcripts to Ollama and extracts structured insights using JSON schema mode.
  Short transcripts are handled in a single call. Long transcripts are split into
  chunks via Synthesis.Chunker, processed in parallel (bounded by chunk_concurrency),
  deduplicated by normalised title, then merged into a final result.
  """

  require Logger

  # --- Public ---

  @spec extract(String.t()) :: {:ok, map()} | {:error, String.t()}
  def extract(transcript) do
    threshold = Application.get_env(:synthesis, :single_chunk_threshold, 2500)
    estimated_tokens = div(byte_size(transcript), 4)

    if estimated_tokens <= threshold do
      Logger.info("Short transcript (#{estimated_tokens} tokens) — single-call extraction.")
      do_extract(transcript, 0, Application.get_env(:synthesis, :max_retries, 3))
    else
      Logger.info("Long transcript (#{estimated_tokens} tokens) — chunked extraction.")
      chunked_extract(transcript)
    end
  end

  # --- Single-call path (unchanged) ---

  defp do_extract(_transcript, attempt, max) when attempt >= max,
    do: {:error, "Extraction failed after #{max} attempts"}

  defp do_extract(transcript, attempt, max) do
    with {:ok, body} <- call_ollama(transcript),
         {:ok, result} <- validate(body) do
      {:ok, result}
    else
      {:error, reason} ->
        IO.warn("Attempt #{attempt + 1} failed: #{reason}. Retrying...")
        Process.sleep((30_000 * :math.pow(2, attempt)) |> trunc())
        do_extract(transcript, attempt + 1, max)
    end
  end

  # --- Chunked map-reduce path ---

  defp chunked_extract(transcript) do
    concurrency = Application.get_env(:synthesis, :chunk_concurrency, 2)
    max_retries = Application.get_env(:synthesis, :max_retries, 3)
    chunks = Synthesis.Chunker.chunk(transcript)

    Logger.info("Split into #{length(chunks)} chunks, concurrency: #{concurrency}")

    results =
      chunks
      |> Task.async_stream(
        fn chunk -> do_extract(chunk, 0, max_retries) end,
        max_concurrency: concurrency,
        timeout: Application.get_env(:synthesis, :receive_timeout, 1_200_000)
      )
      |> Enum.reduce_while([], fn
        {:ok, {:ok, result}}, acc -> {:cont, [result | acc]}
        {:ok, {:error, reason}}, _acc -> {:halt, {:error, reason}}
        {:exit, reason}, _acc -> {:halt, {:error, "Chunk task crashed: #{inspect(reason)}"}}
      end)

    case results do
      {:error, _} = err -> err
      chunk_results -> {:ok, merge_results(Enum.reverse(chunk_results))}
    end
  end

  defp merge_results(results) do
    all_insights =
      results
      |> Enum.flat_map(& &1.insights)
      |> deduplicate_insights()

    summary =
      results
      |> Enum.map(& &1.summary)
      |> Enum.join(" ")

    %{summary: summary, insights: all_insights}
  end

  # Normalise title → downcase, strip punctuation, collapse whitespace.
  # Keep the first occurrence of any duplicate.
  defp deduplicate_insights(insights) do
    insights
    |> Enum.uniq_by(fn %{title: t} ->
      t
      |> String.downcase()
      |> String.replace(~r/[^\w\s]/, "")
      |> String.replace(~r/\s+/, " ")
      |> String.trim()
    end)
  end

  # --- Ollama call + validation (unchanged) ---

  defp call_ollama(transcript) do
    url = Application.fetch_env!(:synthesis, :ollama_url)
    model = Application.fetch_env!(:synthesis, :ollama_model)
    temperature = Application.fetch_env!(:synthesis, :temperature)
    receive_timeout = Application.fetch_env!(:synthesis, :receive_timeout)

    case Req.post("#{url}/api/generate",
           json: %{
             model: model,
             prompt: build_prompt(transcript),
             stream: false,
             format: "json",
             options: %{temperature: temperature, num_predict: 4096}
           },
           receive_timeout: receive_timeout
         ) do
      {:ok, %{status: 200, body: body}} ->
        text =
          Map.get(body, "response", "")
          |> then(fn r ->
            if r == "", do: Map.get(body, "thinking", ""), else: r
          end)

        case text |> strip_thinking() |> Jason.decode() do
          {:ok, parsed} -> {:ok, parsed}
          {:error, r} -> {:error, "JSON decode failed: #{inspect(r)}"}
        end

      {:ok, %{status: status}} ->
        {:error, "Ollama returned HTTP #{status}"}

      {:error, reason} ->
        {:error, "HTTP request failed: #{inspect(reason)}"}
    end
  end

  defp strip_thinking(response),
    do: Regex.replace(~r/<think>.*?<\/think>/s, response, "") |> String.trim()

  def validate(%{"summary" => summary, "insights" => insights})
      when is_binary(summary) and is_list(insights) do
    {:ok, %{summary: summary, insights: Enum.map(insights, &normalise_insight/1)}}
  end

  def validate(_), do: {:error, "Response missing required fields"}

  defp normalise_insight(raw) do
    %{
      title: Map.get(raw, "title", "Untitled"),
      question: Map.get(raw, "question", ""),
      content: Map.get(raw, "content", ""),
      tags: Map.get(raw, "tags", []),
      related: Map.get(raw, "related", [])
    }
  end

  defp build_prompt(transcript) do
    """
    # Role
    You are an expert British knowledge engineer and scientific curator.
    Your job is to carefully study a document and distil every important piece of information a reader should learn from it.

    # Task
    Analyse the following transcript.
    Extract every distinct, standalone, important insight.
    Each insight must be fully self-contained: name all subjects explicitly, never use pronouns like "it", "this", or "they" without a clear referent.
    Before finalising, review all insights and merge any that cover the same or highly overlapping concepts into a single, more complete insight.
    The "related" field must only reference titles of other insights in your list.
    A reader should be able to faithfully reconstruct the full substance of the transcript by studying all zettels, the summary, and the index — without access to the original.

    # Output format
    You MUST respond with valid JSON only. No explanation, no markdown, no code fences.

    {
      "summary": "Max 3 paragraph overview of the main discussion",
      "insights": [
        {
          "title": "Short title, max 6 words",
          "question": "The precise question this insight answers, written as a natural search query",
          "content": "Max 5 self-contained sentences explaining the insight clearly, naming all subjects explicitly",
          "tags": ["relevant", "topic", "keywords"],
          "related": ["Title of related insight", "Another related title"]
        }
      ]
    }

    # Transcript
    #{transcript}
    """
  end
end
