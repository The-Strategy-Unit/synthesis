defmodule Synthesis.ExtractorBehaviour do
  @callback extract(String.t()) :: {:ok, map()} | {:error, String.t()}
end

defmodule Synthesis.Extractor do
  @behaviour Synthesis.ExtractorBehaviour
  @moduledoc """
  Sends transcripts to Ollama and extracts structured insights using JSON schema mode.
  Retries on validation failure up to the configured limit.
  """

  @type transcript :: String.t()
  @type insight :: %{
          title: String.t(),
          content: String.t(),
          tags: [String.t()],
          related: [String.t()]
        }
  @type extraction :: %{summary: String.t(), insights: [insight()]}
  @type extract_result :: {:ok, extraction()} | {:error, String.t()}

  @json_schema %{
    type: "object",
    required: ["summary", "insights"],
    properties: %{
      summary: %{type: "string"},
      insights: %{
        type: "array",
        items: %{
          type: "object",
          required: ["title", "content", "tags", "related"],
          properties: %{
            title: %{type: "string"},
            content: %{type: "string"},
            tags: %{type: "array", items: %{type: "string"}},
            related: %{type: "array", items: %{type: "string"}}
          }
        }
      }
    }
  }

  @spec extract(transcript()) :: extract_result()
  def extract(transcript) do
    max_retries = Application.get_env(:synthesis, :max_retries, 3)
    do_extract(transcript, 0, max_retries)
  end

  @spec do_extract(transcript(), non_neg_integer(), non_neg_integer()) :: extract_result()
  defp do_extract(_transcript, attempt, max) when attempt >= max do
    {:error, "Extraction failed after #{max} attempts"}
  end

  defp do_extract(transcript, attempt, max) do
    case call_ollama(transcript) do
      {:ok, body} ->
        validate(body)

      {:error, reason} ->
        IO.warn("Attempt #{attempt + 1} failed: #{reason}. Retrying...")
        do_extract(transcript, attempt + 1, max)
    end
    |> case do
      {:ok, _} = result ->
        result

      {:error, reason} ->
        IO.warn("Attempt #{attempt + 1} validation failed: #{reason}. Retrying...")
        do_extract(transcript, attempt + 1, max)
    end
  end

  @spec call_ollama(transcript()) :: {:ok, map()} | {:error, String.t()}
  defp call_ollama(transcript) do
    url = Application.fetch_env!(:synthesis, :ollama_url)
    model = Application.fetch_env!(:synthesis, :ollama_model)

    Req.post("#{url}/api/generate",
      json: %{
        model: model,
        prompt: build_prompt(transcript),
        stream: false,
        format: @json_schema
      }
    )
    |> case do
      {:ok, %{status: 200, body: %{"response" => response}}} ->
        Jason.decode(response)
        |> case do
          {:ok, parsed} -> {:ok, parsed}
          {:error, reason} -> {:error, "JSON decode failed: #{inspect(reason)}"}
        end

      {:ok, %{status: status}} ->
        {:error, "Ollama returned HTTP #{status}"}

      {:error, reason} ->
        {:error, "HTTP request failed: #{inspect(reason)}"}
    end
  end

  @spec validate(map()) :: extract_result()
  defp validate(%{"summary" => summary, "insights" => insights})
       when is_binary(summary) and is_list(insights) do
    {:ok,
     %{
       summary: summary,
       insights: Enum.map(insights, &normalise_insight/1)
     }}
  end

  defp validate(_), do: {:error, "Response missing required fields"}

  @spec normalise_insight(map()) :: insight()
  defp normalise_insight(raw) do
    %{
      title: Map.get(raw, "title", "Untitled"),
      content: Map.get(raw, "content", ""),
      tags: Map.get(raw, "tags", []),
      related: Map.get(raw, "related", [])
    }
  end

  @spec build_prompt(transcript()) :: String.t()
  defp build_prompt(transcript) do
    """
    You are an expert knowledge curator. Analyse the following podcast transcript.

    TASK 1 - SUMMARY: Write a concise 2-3 paragraph overview of the main discussion.

    TASK 2 - ATOMIC INSIGHTS: Extract every distinct, standalone insight from the transcript.
    For each insight:
    - title: short descriptive title (max 6 words)
    - content: 1-2 sentences explaining the insight clearly
    - tags: relevant topic keywords
    - related: titles of other insights in this list that connect to this one

    TRANSCRIPT:
    #{transcript}
    """
  end
end
