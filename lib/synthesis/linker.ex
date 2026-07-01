defmodule Synthesis.Linker do
  @moduledoc """
  Builds semantic links between zettels using stored embeddings.
  Links are stored in zettel_links; summaries are not graph nodes.
  """

  alias Synthesis.Store

  @default_k 5

  @spec link_all(non_neg_integer()) :: :ok
  def link_all(k \\ @default_k) do
    Store.clear_links("auto")

    {:ok, zettels} = Store.all_zettels()

    top_k =
      zettels
      |> Enum.map(fn z ->
        case Store.get_zettel_embedding(z.id) do
          {:ok, vector} ->
            {:ok, neighbours} = Store.nearest_neighbours(z.id, vector, z.episode_id, k)
            {z.id, neighbours}

          {:error, :not_found} ->
            IO.warn("No embedding for zettel #{z.id}; skipping")
            {z.id, []}
        end
      end)
      |> Map.new()

    for {a, neighbours} <- top_k,
        %{id: b, strength: s} <- neighbours,
        a in Enum.map(Map.get(top_k, b, []), & &1.id),
        a < b do
      Store.insert_zettel_link(a, b, s, "auto")
      Store.insert_zettel_link(b, a, s, "auto")
    end

    :ok
  end
end
