defmodule Synthesis.WriterBehaviour do
  @callback write(String.t(), String.t() | nil, map()) :: :ok | {:error, String.t()}
end

defmodule Synthesis.Writer do
  @behaviour Synthesis.WriterBehaviour
  @moduledoc """
  Writes extracted insights and summaries to Obsidian-ready Zettelkasten markdown files.
  Output is organised per video source under the configured output directory.
  """

  alias Synthesis.Utils

  @type video_id :: String.t()
  @type insight :: %{
          title: String.t(),
          content: String.t(),
          tags: [String.t()],
          related: [String.t()]
        }
  @type extraction :: %{summary: String.t(), insights: [insight()]}
  @type write_result :: :ok | {:error, String.t()}

  @spec write(video_id(), String.t() | nil, map(), String.t()) :: write_result()
  def write(video_id, title, %{summary: summary, insights: insights}, domain \\ "general") do
    base_dir = Application.fetch_env!(:synthesis, :output_dir)
    slug = Utils.slugify(title || "")
    dir_name = if slug != "", do: "#{slug}_#{video_id}", else: video_id
    source_dir = Path.join([base_dir, domain, dir_name])
    insight_dir = Path.join(source_dir, "insights")

    with :ok <- File.mkdir_p(insight_dir),
         :ok <- write_summary(source_dir, video_id, summary, insights),
         :ok <- write_insights(insight_dir, video_id, insights) do
      :ok
    else
      {:error, reason} -> {:error, "Write failed: #{inspect(reason)}"}
    end
  end

  # --- Summary ---

  defp write_summary(dir, video_id, summary, insights) do
    links =
      Enum.map(insights, fn %{title: t} ->
        "- [[insights/#{Utils.slugify(t)}|#{t}]]"
      end)

    content = """
    ---
    id: #{video_id}
    source: https://www.youtube.com/watch?v=#{video_id}
    date: #{Date.utc_today()}
    type: summary
    ---

    # Summary

    #{summary}

    ## Insights

    #{Enum.join(links, "\n")}
    """

    case File.write(Path.join(dir, "summary.md"), content) do
      :ok ->
        :ok

      {:error, reason} ->
        {:error, "Failed to write summary for #{video_id}: #{:file.format_error(reason)}"}
    end
  end

  # --- Insights ---

  defp write_insights(dir, video_id, insights) do
    Enum.reduce_while(insights, :ok, fn insight, :ok ->
      case write_insight(dir, video_id, insight) do
        :ok -> {:cont, :ok}
        {:error, _} = e -> {:halt, e}
      end
    end)
  end

  defp write_insight(dir, video_id, %{
         title: title,
         content: content,
         tags: tags,
         related: related
       }) do
    related_links = Enum.map(related, fn r -> "- [[#{Utils.slugify(r)}|#{r}]]" end)
    tags_str = tags |> Enum.map(&Utils.slugify/1) |> Enum.join(", ")
    related_str = related |> Enum.map(&Utils.slugify/1) |> Enum.join(", ")

    note = """
    ---
    id: #{Utils.slugify(title)}
    source: #{video_id}
    date: #{Date.utc_today()}
    tags: [#{tags_str}]
    related: [#{related_str}]
    type: insight
    ---

    # #{title}

    #{content}

    ## Related

    #{if related_links == [], do: "_none_", else: Enum.join(related_links, "\n")}
    """

    case File.write(Path.join(dir, "#{Utils.slugify(title)}.md"), note) do
      :ok ->
        :ok

      {:error, reason} ->
        {:error, "Failed to write insight '#{title}': #{:file.format_error(reason)}"}
    end
  end

  @spec write_index(String.t()) :: write_result()
  def write_index(domain \\ "general") do
    base_dir = Application.fetch_env!(:synthesis, :output_dir)
    domain_dir = Path.join(base_dir, domain)

    with {:ok, episodes} <- Synthesis.Store.all_episodes_with_zettels(domain),
         :ok <- File.mkdir_p(domain_dir) do
      all_tags =
        episodes
        |> Enum.flat_map(& &1.zettels)
        |> Enum.flat_map(fn z -> String.split(z.tags || "", ", ", trim: true) end)
        |> Enum.frequencies()
        |> Enum.sort_by(fn {_, count} -> -count end)
        |> Enum.map(fn {tag, count} -> "#{tag} (#{count})" end)
        |> Enum.join(", ")

      total_zettels = episodes |> Enum.map(&length(&1.zettels)) |> Enum.sum()

      header = """
      # Synthesis Index — #{domain}

      - **Episodes**: #{length(episodes)}
      - **Insights**: #{total_zettels}
      - **Tags**: #{all_tags}

      ---

      """

      body =
        Enum.map_join(episodes, "\n\n", fn ep ->
          ep_tags =
            ep.zettels
            |> Enum.flat_map(fn z -> String.split(z.tags || "", ", ", trim: true) end)
            |> Enum.uniq()
            |> Enum.join(", ")

          insight_lines =
            Enum.map_join(ep.zettels, "\n", fn z ->
              [first_line | _] = String.split(z.insight, "\n", parts: 2)
              content = z.insight |> String.split("\n") |> Enum.drop(1) |> Enum.join(" ")
              "  - **#{first_line}** — #{content}"
            end)

          """
          ## #{ep.title || ep.url}
          - **URL**: #{ep.url}
          - **Added**: #{ep.fetched_at}
          - **Tags**: #{ep_tags}
          - **Insights** (#{length(ep.zettels)}):
          #{insight_lines}
          """
        end)

      case File.write(Path.join(domain_dir, "index.md"), header <> body) do
        :ok -> write_top_level_index(base_dir)
        {:error, reason} -> {:error, "Index generation failed: #{inspect(reason)}"}
      end
    else
      {:error, reason} -> {:error, "Index generation failed: #{inspect(reason)}"}
    end
  end

  @spec write_global_index() :: write_result()
  def write_global_index do
    base_dir = Application.fetch_env!(:synthesis, :output_dir)

    with {:ok, domains} <- Synthesis.Store.list_domains(),
         :ok <- File.mkdir_p(base_dir) do
      total_episodes = Enum.sum(Enum.map(domains, fn {_, count} -> count end))

      header = """
      # Synthesis Index

      - **Domains**: #{length(domains)}
      - **Episodes**: #{total_episodes}

      ---

      """

      body =
        Enum.map_join(domains, "\n\n", fn {domain, count} ->
          """
          ## [[#{domain}/index|#{domain}]]

          - **Episodes**: #{count}
          """
        end)

      File.write(Path.join(base_dir, "index.md"), header <> body <> "\n")
    end
  end

  defp write_top_level_index(base_dir) do
    with {:ok, entries} <- File.ls(base_dir) do
      domains =
        entries
        |> Enum.filter(fn entry -> File.dir?(Path.join(base_dir, entry)) end)
        |> Enum.sort()

      links = Enum.map_join(domains, "\n", fn d -> "- [[#{d}/index|#{d}]]" end)

      content = """
      # Synthesis — Knowledge Base

      #{links}
      """

      case File.write(Path.join(base_dir, "index.md"), content) do
        :ok -> :ok
        {:error, reason} -> {:error, "Top-level index failed: #{inspect(reason)}"}
      end
    else
      {:error, reason} ->
        {:error, "Top-level index failed to list domains: #{:file.format_error(reason)}"}
    end
  end
end
