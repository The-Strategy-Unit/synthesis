defmodule UpdateLinks do
  alias Synthesis.{Repo, Utils}

  def run do
    {:ok, _} = Application.ensure_all_started(:synthesis)

    zettels = load_zettels()
    links = load_links()

    output_dir = Application.fetch_env!(:synthesis, :output_dir)

    for domain <- File.ls!(output_dir),
        domain != ".obsidian",
        domain_dir = Path.join(output_dir, domain),
        File.dir?(domain_dir),
        entry <- File.ls!(domain_dir),
        entry_dir = Path.join(domain_dir, entry),
        File.dir?(entry_dir) do
      update_insight_dir(entry_dir, links, zettels, domain, entry)
      clean_summary(Path.join(entry_dir, "summary.md"))
    end

    IO.puts("Done updating links.")
  end

  defp load_zettels do
    sql = "SELECT z.id, z.insight, z.episode_id FROM zettels z"
    {:ok, %{rows: rows}} = Repo.query(sql, [])

    rows
    |> Enum.map(fn [id, insight, episode_id] ->
      [title | _] = String.split(insight, "\n", parts: 2)
      {id, %{id: id, title: String.trim(title), episode_id: episode_id}}
    end)
    |> Map.new()
  end

  defp load_links do
    sql = "SELECT zettel_id, related_zettel_id, strength FROM zettel_links WHERE source = 'auto'"
    {:ok, %{rows: rows}} = Repo.query(sql, [])

    rows
    |> Enum.group_by(
      fn [id, _, _] -> id end,
      fn [_, rel_id, strength] -> {rel_id, strength} end
    )
  end

  defp update_insight_dir(dir, links, zettels, domain, entry) do
    insight_dir = Path.join(dir, "insights")
    # vault_prefix = Path.join([domain, entry, "insights"])

    if File.dir?(insight_dir) do
      for file <- Path.wildcard(Path.join(insight_dir, "*.md")) do
        content = File.read!(file)

        title =
          content
          |> String.split("\n", parts: 3)
          |> List.last()
          |> String.trim_leading("# ")

        case Enum.find(zettels, fn {_, z} -> z.title == title end) do
          nil ->
            :ok

          {id, _} ->
            links_md = format_links(Map.get(links, id, []), zettels, domain, entry)

            new_content =
              case String.split(content, "## Related\n", parts: 2) do
                [before, _after] -> before <> links_md <> "\n"
                [before] -> before <> "\n\n" <> links_md <> "\n"
              end

            File.write!(file, new_content)
        end
      end
    end
  end

  defp format_links([], _zettels, _domain, _entry) do
    "## Related\n\n_none_"
  end

  defp format_links(links, zettels, domain, _entry) do
    links_md =
      links
      |> Enum.map(fn {rel_id, strength} ->
        %{title: title, episode_id: episode_id} = Map.fetch!(zettels, rel_id)

        {:ok, %{rows: rows}} =
          Repo.query(
            "SELECT e.title, e.video_id FROM episodes e WHERE e.id = ?",
            [episode_id]
          )

        [episode_title, video_id] = hd(rows)
        ep_slug = Utils.slugify(episode_title || "")
        ep_dir = if ep_slug != "", do: "#{ep_slug}_#{video_id}", else: video_id
        r_slug = Utils.slugify(title)

        "- [[#{domain}/#{ep_dir}/insights/#{r_slug}|#{title}]] _(#{Float.round(strength, 3)})_"
      end)
      |> Enum.join("\n")

    "## Related\n\n#{links_md}"
  end

  defp clean_summary(path) do
    if File.exists?(path) do
      content = File.read!(path)

      case String.split(content, "\n## Insights\n", parts: 2) do
        [before, _] -> File.write!(path, before)
        [_] -> :ok
      end
    end
  end
end

UpdateLinks.run()
