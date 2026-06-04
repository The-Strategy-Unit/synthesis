defmodule Synthesis.Embedder do
  @moduledoc """
  Generates embeddings via Ollama's /api/embeddings endpoint.

  Prepends task-specific prefixes for Qwen3-Embedding:
  - `search_document:` when embedding zettels for storage
  - `search_query:` when embedding queries for search
  """

  @type vector :: [float()]

  @spec embed_document(String.t()) :: {:ok, vector()} | {:error, term()}
  def embed_document(text), do: embed("search_document: #{text}")

  @spec embed_query(String.t()) :: {:ok, vector()} | {:error, term()}
  def embed_query(text), do: embed("search_query: #{text}")

  defp embed(text) do
    url = Application.fetch_env!(:synthesis, :ollama_url)
    model = Application.fetch_env!(:synthesis, :ollama_model_embed)
    receive_timeout = Application.fetch_env!(:synthesis, :receive_timeout)

    case Req.post("#{url}/api/embeddings",
           json: %{model: model, prompt: text},
           receive_timeout: receive_timeout
         ) do
      {:ok, %{status: 200, body: %{"embedding" => vector}}} ->
        {:ok, vector}

      {:ok, %{status: status}} ->
        {:error, "Ollama returned HTTP #{status}"}

      {:error, reason} ->
        {:error, "HTTP request failed: #{inspect(reason)}"}
    end
  end
end
