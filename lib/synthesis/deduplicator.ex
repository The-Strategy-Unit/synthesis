defmodule Synthesis.Deduplicator do
  @moduledoc """
  Cross-episode semantic deduplication of zettels.

  Uses nearest_neighbours to find zettels with embedding similarity ≥ 0.95
  across different episodes, then merges duplicates into the oldest (lowest ID)
  survivor - combining tags and keeping the longer insight body.
  """

  alias Synthesis.{Store, Repo, Utils}

  # Cosine similarity threshold - 0.95 means "almost identical meaning"
  @threshold 0.95

  # Over-fetch neighbours so we catch all dupes even in dense clusters;
  # the threshold filter discards non-matches cheaply
  @k 20

  @spec run() :: {:ok, non_neg_integer()}
  def run do
    {:ok, zettels} = Store.all_zettels()

    # Walk all zettels in DB order; `deleted` tracks already-merged IDs
    # so we never process or re-merge a zettel that's been killed
    {merge_count, _deleted} =
      Enum.reduce(zettels, {0, MapSet.new()}, fn z, {count, deleted} ->
        if MapSet.member?(deleted, z.id) do
          {count, deleted}
        else
          dedup_one(z, count, deleted)
        end
      end)

    {:ok, merge_count}
  end

  defp dedup_one(z, count, deleted) do
    case Store.get_zettel_embedding(z.id) do
      {:ok, vector} ->
        # nearest_neighbours already excludes same-episode zettels,
        # so we only get cross-episode candidates (within-episode
        # dedup is already handled by the Extractor's title-based dedup)
        {:ok, neighbours} = Store.nearest_neighbours(z.id, vector, z.episode_id, @k)

        dupes =
          neighbours
          |> Enum.filter(fn n -> n.strength >= @threshold end)
          |> Enum.filter(fn n -> not MapSet.member?(deleted, n.id) end)
          # Only merge higher IDs into lower IDs - prevents processing
          # the same pair from both directions
          |> Enum.filter(fn n -> n.id > z.id end)

        {new_count, new_deleted} =
          Enum.reduce(dupes, {count, deleted}, fn n, {c, d} ->
            # keep = oldest (lowest ID), kill = newest (highest ID)
            {keep, kill} = if z.id < n.id, do: {z, n}, else: {n, z}
            merge_zettels(keep, kill)
            {c + 1, MapSet.put(d, kill.id)}
          end)

        {new_count, new_deleted}

      {:error, :not_found} ->
        IO.warn("No embedding for zettel #{z.id}; skipping dedup")
        {count, deleted}
    end
  end

  defp merge_zettels(keep, kill) do
    merged_tags = union_tags(keep.tags, kill.tags)
    merged_insight = longer_insight(keep.insight, kill.insight)

    Store.update_zettel(keep.id, merged_tags, merged_insight)
    Store.rewire_links(kill.id, keep.id)
    Store.delete_zettel(kill.id)
    delete_zettel_file(kill)
  end

  defp delete_zettel_file(zettel) do
    # Look up the episode to get video_id and title for the directory path
    {:ok, %{rows: [[episode_title, video_id]]}} =
      Repo.query("SELECT title, video_id FROM episodes WHERE id = ?", [zettel.episode_id])

    # Zettel title is the first line of the insight field
    [title | _] = String.split(zettel.insight, "\n", parts: 2)

    output_dir = Application.fetch_env!(:synthesis, :output_dir)
    ep_slug = Utils.slugify(episode_title || "")
    dir_name = if ep_slug != "", do: "#{ep_slug}_#{video_id}", else: video_id
    zettel_slug = Utils.slugify(String.trim(title))

    file_path = Path.join([output_dir, zettel.domain, dir_name, "insights", "#{zettel_slug}.md"])

    case File.rm(file_path) do
      :ok ->
        :ok

      # file already gone — fine
      {:error, :enoent} ->
        :ok

      {:error, reason} ->
        IO.warn("Failed to delete orphan #{file_path}: #{:file.format_error(reason)}")
    end
  end

  # Tags are stored as comma-separated strings in the DB
  defp union_tags(nil, nil), do: nil
  defp union_tags(a, nil), do: a
  defp union_tags(nil, b), do: b

  defp union_tags(a, b) do
    (String.split(a, ", ", trim: true) ++ String.split(b, ", ", trim: true))
    |> Enum.uniq()
    |> Enum.join(", ")
  end

  defp longer_insight(nil, b), do: b
  defp longer_insight(a, nil), do: a
  defp longer_insight(a, b), do: if(String.length(a) >= String.length(b), do: a, else: b)
end
