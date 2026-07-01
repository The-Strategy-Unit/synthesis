defmodule Synthesis.WikiUpdater do
  @moduledoc """
  Rewrites the `## Related` sections in all insight markdown files from the
  current `zettel_links` table.

  Called automatically after new ingest, or manually via `mix wiki.update_links`.
  """

  alias Synthesis.{Repo, Utils}

  @spec run() :: :ok
  def run do
    zettels = load_zettels()
    links = load_links()
    video_to_episode = load_video_to_episode()
    output_dir = Application.fetch_env!(:synthesis, :output_dir)

    for domain <- File.ls!(output_dir),
        domain != ".obsidian",
        domain_dir = Path.join(output_dir, domain),
        File.dir?(domain_dir),
        entry <- File.ls!(domain_dir),
        entry_dir = Path.join(domain_dir, entry),
        File.dir?(entry_dir) do
      update_source_dir(entry_dir, links, zettels, video_to_episode, domain, entry)
      clean_summary(Path.join(entry_dir, "summary.md"))
    end

    :ok
  end

  # --- loaders ---

  defp load_zettels do
    {:ok, %{rows: rows}} = Repo.query("SELECT id, insight, episode_id FROM zettels", [])

    Map.new(rows, fn [id, insight, episode_id] ->
      [title | _] = String.split(insight, "\n", parts: 2)
      {id, %{id: id, title: String.trim(title), episode_id: episode_id}}
    end)
  end

  defp load_links do
    {:ok, %{rows: rows}} =
      Repo.query("SELECT zettel_id, related_zettel_id, strength FROM zettel_links WHERE source = 'auto'", [])

    Enum.group_by(rows, fn [id, _, _] -> id end, fn [_, rel_id, s] -> {rel_id, s} end)
  end

  defp load_video_to_episode do
    {:ok, %{rows: rows}} = Repo.query("SELECT id, video_id FROM episodes", [])
    Map.new(rows, fn [id, video_id] -> {video_id, id} end)
  end

  # --- file rewriting ---

  defp update_source_dir(dir, links, zettels, video_to_episode, domain, entry) do
    insight_dir = Path.join(dir, "insights")
    video_id = video_id_from_entry(entry)
    episode_id = Map.get(video_to_episode, video_id)

    if File.dir?(insight_dir) and not is_nil(episode_id) do
      episode_zettels = Enum.filter(zettels, fn {_, z} -> z.episode_id == episode_id end)

      for file <- Path.wildcard(Path.join(insight_dir, "*.md")) do
        content = File.read!(file)
        title = extract_title(content)

        case Enum.find(episode_zettels, fn {_, z} -> z.title == title end) do
          nil ->
            :ok

          {id, _} ->
            links_md = format_links(Map.get(links, id, []), zettels, domain)
            File.write!(file, replace_related_section(content, links_md))
        end
      end
    end
  end

  defp video_id_from_entry(entry) do
    entry |> String.split("_") |> List.last()
  end

  defp extract_title(content) do
    content
    |> String.split("\n")
    |> Enum.find_value(fn line ->
      case String.trim(line) do
        "# " <> title -> String.trim(title)
        _ -> nil
      end
    end)
  end

  defp replace_related_section(content, links_md) do
    case String.split(content, "\n## Related\n", parts: 2) do
      [before, _after] -> before <> "\n" <> links_md <> "\n"
      [before] -> before <> "\n\n" <> links_md <> "\n"
    end
  end

  defp format_links([], _zettels, _domain) do
    "## Related\n\n_none_"
  end

  defp format_links(links, zettels, domain) do
    links_md =
      links
      |> Enum.sort_by(fn {_, strength} -> strength end, :desc)
      |> Enum.map(fn {rel_id, strength} ->
        %{title: title, episode_id: episode_id} = Map.fetch!(zettels, rel_id)

        {:ok, %{rows: [[episode_title, video_id]]}} =
          Repo.query("SELECT title, video_id FROM episodes WHERE id = ?", [episode_id])

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
