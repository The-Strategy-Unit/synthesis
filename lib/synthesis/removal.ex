defmodule Synthesis.Removal do
  @moduledoc """
  Removes an episode and all derived data from the database, filesystem,
  and downstream indexes.
  """

  alias Synthesis.{Store, Utils, Writer}

  @spec remove_episode(map(), keyword()) :: :ok | {:error, term()}
  def remove_episode(episode, opts \\ []) do
    force = Keyword.get(opts, :force, false)

    with :ok <- confirm(episode, force),
         {:ok, zettels} <- Store.get_zettels_for_episode(episode.id),
         :ok <- Store.delete_episode(episode.id),
         :ok <- remove_output_directory(episode),
         :ok <- cleanup_markdown_references(zettels),
         :ok <- Writer.write_index(episode.domain),
         :ok <- Writer.write_global_index() do
      :ok
    end
  end

  # --- Private ---

  defp confirm(_episode, true), do: :ok

  defp confirm(episode, false) do
    label = if episode.title, do: "#{episode.title} (#{episode.video_id})", else: episode.video_id

    IO.puts("About to delete episode: #{label}")
    IO.puts("This will remove all zettels, embeddings, links, and output files.")
    IO.write("Type 'yes' to confirm: ")

    case IO.gets("") do
      :eof -> {:error, :cancelled}
      input -> if String.trim(input) == "yes", do: :ok, else: {:error, :cancelled}
    end
  end

  defp remove_output_directory(episode) do
    base_dir = Application.fetch_env!(:synthesis, :output_dir)
    slug = Utils.slugify(episode.title || "")
    dir_name = if slug != "", do: "#{slug}_#{episode.video_id}", else: episode.video_id
    path = Path.join([base_dir, episode.domain, dir_name])

    case File.rm_rf(path) do
      {:ok, _} -> :ok
      {:error, reason, _} -> {:error, "Failed to remove output directory: #{inspect(reason)}"}
    end
  end

  defp cleanup_markdown_references(zettels) do
    slugs = Enum.map(zettels, & &1.slug)
    base_dir = Application.fetch_env!(:synthesis, :output_dir)

    base_dir
    |> Path.join("**/*.md")
    |> Path.wildcard()
    |> Enum.reduce_while(:ok, fn path, :ok ->
      case clean_file(path, slugs) do
        :ok -> {:cont, :ok}
        {:error, _} = err -> {:halt, err}
      end
    end)
  end

  defp clean_file(path, slugs) do
    content = File.read!(path)
    cleaned = clean_content(content, slugs)

    if cleaned != content do
      File.write!(path, cleaned)
    end

    :ok
  rescue
    e -> {:error, "Failed to clean #{path}: #{inspect(e)}"}
  end

  defp clean_content(content, slugs) do
    content
    |> remove_deleted_wikilink_lines(slugs)
    |> process_sections()
    |> normalize_content()
  end

  defp remove_deleted_wikilink_lines(content, slugs) do
    slug_pattern = slugs |> Enum.map(&Regex.escape/1) |> Enum.join("|")

    Regex.replace(
      ~r/^- \[\[(?:#{slug_pattern})\|[^\]]+\]\].*$\n?/m,
      content,
      ""
    )
  end

  defp process_sections(content) do
    lines = String.split(content, "\n")

    sections =
      Enum.chunk_while(
        lines,
        [],
        fn line, acc ->
          if String.starts_with?(line, "## ") do
            {:cont, Enum.reverse(acc), [line]}
          else
            {:cont, [line | acc]}
          end
        end,
        fn acc -> {:cont, Enum.reverse(acc), []} end
      )

    processed = Enum.map(sections, &process_section/1)

    processed
    |> Enum.map(&Enum.join(&1, "\n"))
    |> Enum.join("\n")
  end

  defp process_section(["## Cross-domain" | rest]) do
    if has_list_items?(rest), do: ["## Cross-domain" | rest], else: []
  end

  defp process_section(["## Related" | rest]) do
    if has_list_items?(rest) do
      ["## Related" | rest]
    else
      trailing = if List.last(rest) == "", do: [""], else: []
      ["## Related", "_none_" | trailing]
    end
  end

  defp process_section(section), do: section

  defp has_list_items?(lines) do
    Enum.any?(lines, &String.starts_with?(&1, "- "))
  end

  defp normalize_content(content) do
    content
    |> String.replace(~r/(?<!\n)\n(## )/, "\n\n\\1")
    |> String.replace(~r/\n{3,}/, "\n\n")
    |> String.trim_trailing()
    |> Kernel.<>("\n")
  end
end
