Mix.Task.run("app.start")

{:ok, zettels} = Synthesis.Store.all_zettels()
IO.puts("Total zettels: #{length(zettels)}")

# Sample a few zettels spread across the dataset
sample_ids = [1, div(length(zettels), 2), length(zettels)]

for id <- sample_ids do
  z = Enum.find(zettels, &(&1.id == id))

  if z do
    case Synthesis.Store.get_zettel_embedding(z.id) do
      {:ok, vector} ->
        {:ok, neighbours} = Synthesis.Store.nearest_neighbours(z.id, vector, z.episode_id, 20)
        top = hd(neighbours)

        IO.puts(
          "\nZettel #{z.id} (ep #{z.episode_id}): top neighbour = #{top.id} strength=#{Float.round(top.strength, 4)}"
        )

        IO.puts(
          "  All strengths: #{Enum.map(neighbours, &Float.round(&1.strength, 3)) |> Enum.join(", ")}"
        )

      {:error, :not_found} ->
        IO.puts("\nZettel #{z.id}: NO EMBEDDING")
    end
  end
end

# Count zettels with embeddings
has_embedding =
  Enum.count(zettels, fn z ->
    case Synthesis.Store.get_zettel_embedding(z.id) do
      {:ok, _} -> true
      _ -> false
    end
  end)

IO.puts("\nZettels with embeddings: #{has_embedding}/#{length(zettels)}")

# Find the global max similarity across all zettels
{max_strength, pair} =
  Enum.reduce(zettels, {0.0, nil}, fn z, {best, best_pair} ->
    case Synthesis.Store.get_zettel_embedding(z.id) do
      {:ok, vector} ->
        {:ok, neighbours} = Synthesis.Store.nearest_neighbours(z.id, vector, z.episode_id, 5)

        case neighbours do
          [top | _] when top.strength > best ->
            {top.strength, {z.id, top.id}}

          _ ->
            {best, best_pair}
        end

      _ ->
        {best, best_pair}
    end
  end)

IO.puts(
  "Global max cross-episode similarity: #{Float.round(max_strength, 4)} (zettels #{inspect(pair)})"
)

# Show strength distribution at various thresholds
for threshold <- [0.95, 0.90, 0.85, 0.80, 0.75, 0.70] do
  count =
    Enum.count(zettels, fn z ->
      case Synthesis.Store.get_zettel_embedding(z.id) do
        {:ok, vector} ->
          {:ok, neighbours} = Synthesis.Store.nearest_neighbours(z.id, vector, z.episode_id, 20)
          Enum.any?(neighbours, &(&1.strength >= threshold and &1.id > z.id))

        _ ->
          false
      end
    end)

  IO.puts("  threshold #{threshold}: #{count} zettels would have duplicates")
end

for id <- [67, 142] do
  z = Enum.find(zettels, &(&1.id == id))
  IO.puts("\n=== Zettel #{id} ===")
  IO.puts("Episode: #{z.episode_id}")
  IO.puts("Tags: #{z.tags}")
  IO.puts("Insight: #{z.insight}")
end
