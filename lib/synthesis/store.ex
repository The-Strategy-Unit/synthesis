defmodule Synthesis.Store do
  @moduledoc """
  Persistence layer for episodes, zettels, links, and embeddings.
  All database access goes through Synthesis.Repo.
  """

  alias Synthesis.Repo

  # --- Episodes ---

  @spec insert_episode(String.t(), String.t(), String.t() | nil, String.t()) ::
          {:ok, integer()} | {:error, term()}
  def insert_episode(url, video_id, title, raw_transcript) do
    case Repo.query(
           """
           INSERT INTO episodes (url, video_id, title, raw_transcript)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (url) DO UPDATE SET
             title = excluded.title,
             raw_transcript = excluded.raw_transcript,
             fetched_at = datetime('now')
           RETURNING id
           """,
           [url, video_id, title, raw_transcript]
         ) do
      {:ok, %{rows: [[id]]}} -> {:ok, id}
      {:error, _} = err -> err
    end
  end

  @spec get_episode_by_url(String.t()) :: {:ok, map()} | {:error, :not_found}
  def get_episode_by_url(url) do
    case Repo.query("SELECT id, url, video_id, title, fetched_at FROM episodes WHERE url = ?", [
           url
         ]) do
      {:ok, %{rows: [[id, url, video_id, title, fetched_at]], columns: _}} ->
        {:ok, %{id: id, url: url, video_id: video_id, title: title, fetched_at: fetched_at}}

      {:ok, %{rows: []}} ->
        {:error, :not_found}

      {:error, _} = err ->
        err
    end
  end

  # --- Zettels ---

  @spec insert_zettel(integer(), map()) :: {:ok, integer()} | {:error, term()}
  def insert_zettel(episode_id, %{title: title, content: content, tags: tags}) do
    tags_text = Enum.join(tags, ", ")
    insight = "#{title}\n#{content}"

    case Repo.query(
           """
           INSERT INTO zettels (episode_id, insight, tags)
           VALUES (?, ?, ?)
           RETURNING id
           """,
           [episode_id, insight, tags_text]
         ) do
      {:ok, %{rows: [[id]]}} -> {:ok, id}
      {:error, _} = err -> err
    end
  end

  # --- Zettel Links ---

  @spec insert_zettel_link(integer(), integer()) :: :ok | {:error, term()}
  def insert_zettel_link(zettel_id, related_zettel_id) do
    case Repo.query(
           """
           INSERT OR IGNORE INTO zettel_links (zettel_id, related_zettel_id)
           VALUES (?, ?)
           """,
           [zettel_id, related_zettel_id]
         ) do
      {:ok, _} -> :ok
      {:error, _} = err -> err
    end
  end

  @spec all_episodes_with_zettels() :: {:ok, [map()]} | {:error, term()}
  def all_episodes_with_zettels do
    case Repo.query("""
           SELECT e.id, e.title, e.url, e.fetched_at,
                  z.id, z.insight, z.tags
           FROM episodes e
           LEFT JOIN zettels z ON z.episode_id = e.id
           ORDER BY e.fetched_at DESC, e.id ASC, z.id ASC
         """) do
      {:ok, %{rows: rows}} ->
        {episodes, current_episode} =
          Enum.reduce(rows, {[], nil}, fn
            [eid, title, url, fetched_at, zid, insight, tags], {episodes, nil} ->
              zettels =
                if is_nil(zid) do
                  []
                else
                  [%{insight: insight, tags: tags}]
                end

              {episodes,
               %{id: eid, title: title, url: url, fetched_at: fetched_at, zettels: zettels}}

            [eid, _title, _url, _fetched_at, zid, insight, tags],
            {episodes, %{id: eid} = current_episode} ->
              zettels =
                if is_nil(zid) do
                  current_episode.zettels
                else
                  current_episode.zettels ++ [%{insight: insight, tags: tags}]
                end

              {episodes, %{current_episode | zettels: zettels}}

            [eid, title, url, fetched_at, zid, insight, tags], {episodes, current_episode} ->
              zettels =
                if is_nil(zid) do
                  []
                else
                  [%{insight: insight, tags: tags}]
                end

              {[current_episode | episodes],
               %{id: eid, title: title, url: url, fetched_at: fetched_at, zettels: zettels}}
          end)

        episodes =
          case current_episode do
            nil -> Enum.reverse(episodes)
            episode -> Enum.reverse([episode | episodes])
          end

        {:ok, episodes}

      {:error, _} = err ->
        err
    end
  end

  # --- Embeddings ---

  @spec insert_embedding(integer(), [float()]) :: :ok | {:error, term()}
  def insert_embedding(zettel_id, vector) when is_list(vector) do
    with {:ok, encoded} <- Jason.encode(vector),
         {:ok, _} <-
           Repo.query(
             "INSERT OR REPLACE INTO embeddings (zettel_id, vector) VALUES (?, ?)",
             [zettel_id, encoded]
           ) do
      :ok
    else
      {:error, reason} -> {:error, "Failed to insert embedding: #{inspect(reason)}"}
    end
  end

  # --- Search ---

  @spec search_keyword(String.t()) :: {:ok, [map()]} | {:error, term()}
  def search_keyword(query) do
    term = "%#{query}%"

    case Repo.query(
           """
           SELECT z.id, z.insight, z.tags, e.title, e.url
           FROM zettels z
           JOIN episodes e ON e.id = z.episode_id
           WHERE z.insight LIKE ?
           ORDER BY z.created_at DESC
           """,
           [term]
         ) do
      {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &row_to_zettel/1)}
      {:error, _} = err -> err
    end
  end

  @spec search_semantic(list(), integer()) :: {:ok, [map()]} | {:error, term()}
  def search_semantic(vector, limit \\ 10) when is_list(vector) do
    case Repo.query(
           """
           SELECT z.id, z.insight, z.tags, e.title, e.url, distance
           FROM embeddings
           JOIN zettels z ON z.id = embeddings.zettel_id
           JOIN episodes e ON e.id = z.episode_id
           WHERE embeddings.vector MATCH ?
             AND k = ?
           ORDER BY distance
           """,
           [Jason.encode!(vector), limit]
         ) do
      {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &row_to_zettel_with_distance/1)}
      {:error, _} = err -> err
    end
  end

  # --- Private ---

  defp row_to_zettel([id, insight, tags, episode_title, episode_url]) do
    %{
      id: id,
      insight: insight,
      tags: tags,
      episode_title: episode_title,
      episode_url: episode_url
    }
  end

  defp row_to_zettel_with_distance([id, insight, tags, episode_title, episode_url, distance]) do
    %{
      id: id,
      insight: insight,
      tags: tags,
      episode_title: episode_title,
      episode_url: episode_url,
      distance: distance
    }
  end
end
