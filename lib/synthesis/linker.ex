defmodule Synthesis.Linker do
  @moduledoc """
  Cross-links zettels across domains by finding semantically similar neighbours
  and appending wikilinks to their markdown files.
  """
  alias Synthesis.{Store, Utils}
  require Logger

  def link_zettels(zettel_ids, domain, threshold) do
    base_dir = Application.fetch_env!(:synthesis, :output_dir)

    Enum.each(zettel_ids, fn id ->
      with {:ok, zettels} <- Store.cross_domain_neighbours(id, domain, threshold),
           false <- Enum.empty?(zettels) do
        # find the .md file for this zettel
        {:ok, z} = Store.get_zettel(id)
        [title | _] = String.split(z.insight, "\n", parts: 2)
        slug = Utils.slugify(title)

        pattern = Path.join([base_dir, "**", "#{slug}.md"])

        case Path.wildcard(pattern) do
          [path | _] -> patch_markdown(path, zettels)
          [] -> :ok
        end
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
          "Cross-linking [[#{slug}]] → #{n.domain} (#{Float.round(to_similarity(n.distance), 1)}% similar)"
        )

        "- [[#{slug}|#{title}]] _(#{n.domain})_"
      end)

    content = File.read!(path)

    unless String.contains?(content, "## Cross-domain") do
      File.write!(path, content <> "\n## Cross-domain\n\n#{links}\n")
    end
  end
end
