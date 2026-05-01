defmodule Synthesis.Writer do
  @moduledoc """
  Writes extracted insights and summaries to Obsidian-ready Zettelkasten markdown files.
  Output is organised per video source under the configured output directory.
  """

  alias Synthesis.Extractor
  alias Synthesis.Utils

  @type video_id :: String.t()
  @type write_result :: :ok | {:error, String.t()}

  @spec write(video_id(), Extractor.extraction()) :: write_result()
  def write(video_id, %{summary: summary, insights: insights}) do
    base_dir = Application.fetch_env!(:synthesis, :output_dir)
    source_dir = Path.join(base_dir, video_id)
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

  @spec write_summary(String.t(), video_id(), String.t(), [Extractor.insight()]) :: write_result()
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

    File.write(Path.join(dir, "summary.md"), content)
  end

  # --- Insights ---

  @spec write_insights(String.t(), video_id(), [Extractor.insight()]) :: write_result()
  defp write_insights(dir, video_id, insights) do
    Enum.reduce_while(insights, :ok, fn insight, :ok ->
      case write_insight(dir, video_id, insight) do
        :ok -> {:cont, :ok}
        {:error, _} = e -> {:halt, e}
      end
    end)
  end

  @spec write_insight(String.t(), video_id(), Extractor.insight()) :: write_result()
  defp write_insight(dir, video_id, %{
         title: title,
         content: content,
         tags: tags,
         related: related
       }) do
    related_links = Enum.map(related, fn r -> "- [[#{Utils.slugify(r)}|#{r}]]" end)
    tags_str = Enum.map(tags, &inspect/1) |> Enum.join(", ")

    note = """
    ---
    id: #{Utils.slugify(title)}
    source: #{video_id}
    date: #{Date.utc_today()}
    tags: [#{tags_str}]
    related: #{inspect(Enum.map(related, &Utils.slugify/1))}
    type: insight
    ---

    # #{title}

    #{content}

    ## Related

    #{if related_links == [], do: "_none_", else: Enum.join(related_links, "\n")}
    """

    File.write(Path.join(dir, "#{Utils.slugify(title)}.md"), note)
  end
end
