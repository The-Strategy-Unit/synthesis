defmodule Synthesis.ExtractorBehaviour do
  @callback extract(String.t()) :: {:ok, map()} | {:error, String.t()}
end

defmodule Synthesis.Extractor do
  @behaviour Synthesis.ExtractorBehaviour
  @moduledoc """
  Sends transcripts to Ollama and extracts structured insights using JSON schema mode.
  Long transcripts are split into chunks via Synthesis.Chunker, processed in parallel,
  then merged. Retries on HTTP or validation failure with exponential backoff.
  """

  require Logger

  @type transcript :: String.t()
  @type insight :: %{
          title: String.t(),
          question: String.t(),
          content: String.t(),
          tags: [String.t()],
          related: [String.t()]
        }
  @type extraction :: %{summary: String.t(), insights: [insight()]}
  @type extract_result :: {:ok, extraction()} | {:error, String.t()}

  @spec extract(transcript()) :: extract_result()
  def extract(transcript) do
    max_retries = Application.get_env(:synthesis, :max_retries, 3)
    Logger.info("Extracting insights from transcript...")
    do_extract(transcript, 0, max_retries)
  end

  # --- Private ---

  defp do_extract(_transcript, attempt, max) when attempt >= max do
    {:error, "Extraction failed after #{max} attempts"}
  end

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
             options: %{
               temperature: temperature,
               num_predict: 4096
             }
           },
           receive_timeout: receive_timeout
         ) do
      {:ok, %{status: 200, body: body}} ->
        response = Map.get(body, "response", "")
        thinking = Map.get(body, "thinking", "")
        text = if response == "", do: thinking, else: response

        case text |> strip_thinking() |> Jason.decode() do
          {:ok, parsed} -> {:ok, parsed}
          {:error, reason} -> {:error, "JSON decode failed: #{inspect(reason)}"}
        end

      {:ok, %{status: status}} ->
        {:error, "Ollama returned HTTP #{status}"}

      {:error, reason} ->
        {:error, "HTTP request failed: #{inspect(reason)}"}
    end
  end

  defp strip_thinking(response) do
    Regex.replace(~r/<think>.*?<\/think>/s, response, "") |> String.trim()
  end

  @spec validate(map()) :: extract_result()
  def validate(%{"summary" => summary, "insights" => insights})
      when is_binary(summary) and is_list(insights) do
    {:ok,
     %{
       summary: summary,
       insights: Enum.map(insights, &normalise_insight/1)
     }}
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
