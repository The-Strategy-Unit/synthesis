defmodule Synthesis.Linker do
  @moduledoc """
  Cross-links zettels across domains by finding semantically similar neighbours
  and appending wikilinks to their markdown files.
  """
  alias Synthesis.{Store, Utils}
  require Logger

  def link_zettels(zettel_ids, threshold) do
    base_dir = Application.fetch_env!(:synthesis, :output_dir)

    Enum.reduce_while(zettel_ids, :ok, fn id, _acc ->
      with {:ok, zettels} <- Store.similar_neighbours(id, threshold),
           false <- Enum.empty?(zettels),
           {:ok, z} <- Store.get_zettel(id) do
        [title | _] = String.split(z.insight, "\n", parts: 2)
        slug = Utils.slugify(title)
        pattern = Path.join([base_dir, "**", "#{slug}.md"])

        case Path.wildcard(pattern) do
          [path | _] -> patch_markdown(path, zettels)
          [] -> :ok
        end
        |> case do
          :ok -> {:cont, :ok}
          {:error, _} = err -> {:halt, err}
        end
      else
        # Enum.empty? returned true, skip
        true -> {:cont, :ok}
        {:error, _} = err -> {:halt, err}
      end
    end)
  end

  defp to_similarity(distance), do: (1 - distance / 2) * 100

  defp patch_markdown(path, neighbours) do
    links =
      Enum.map_join(neighbours, "\n", fn n ->
        [title | _] = String.split(n.insight, "\n", parts: 2)
        slug = Utils.slugify(title)

        Logger.info(
          "Linking [[#{slug}]] → #{n.domain} (#{Float.round(to_similarity(n.distance), 1)}% similar)"
        )

        "- [[#{slug}|#{title}]] _(#{n.domain})_"
      end)

    with {:ok, content} <- File.read(path) do
      cleaned =
        Regex.replace(~r/\n## (Cross-domain|Related)\n[\s\S]*?(?=\n## |\z)/, content, "")

      File.write(path, cleaned <> "\n## Related\n\n#{links}\n")
    end
  end
end
