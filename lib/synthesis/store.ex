defmodule Synthesis.Store do
  @moduledoc """
  Persistence layer for episodes, zettels, links, and embeddings.
  All database access goes through Synthesis.Repo.
  """

  alias Synthesis.Repo

  # --- Episodes ---

  @spec insert_episode(String.t(), String.t(), String.t() | nil, String.t(), String.t()) ::
          {:ok, integer()} | {:error, term()}
  def insert_episode(url, video_id, title, raw_transcript, domain \\ "general") do
    case Repo.query(
           """
           INSERT INTO episodes (url, video_id, title, raw_transcript, domain)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (url) DO UPDATE SET
             title = excluded.title,
             raw_transcript = excluded.raw_transcript,
             fetched_at = datetime('now')
           RETURNING id
           """,
           [url, video_id, title, raw_transcript, domain]
         ) do
      {:ok, %{rows: [[id]]}} -> {:ok, id}
      {:error, "UNIQUE constraint failed: " <> _} -> {:error, :already_exists}
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

  def insert_zettel(
        episode_id,
        %{title: title, question: question, content: content, tags: tags},
        domain \\ "general"
      ) do
    tags_text = Enum.join(tags, ", ")

    Repo.query(
      """
      INSERT INTO zettels (episode_id, question, insight, tags, domain)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
      """,
      [episode_id, question, "#{title}\n#{content}", tags_text, domain]
    )
    |> case do
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

  @spec all_episodes_with_zettels(String.t() | nil) :: {:ok, [map()]} | {:error, term()}
  def all_episodes_with_zettels(domain \\ nil) do
    case Repo.query(
           """
             SELECT e.id, e.title, e.url, e.fetched_at,
                    z.id, z.insight, z.tags
             FROM episodes e
             LEFT JOIN zettels z ON z.episode_id = e.id
             WHERE (? IS NULL OR e.domain = ?)
             ORDER BY e.fetched_at DESC, z.id ASC
           """,
           [domain, domain]
         ) do
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

  @spec search_keyword(String.t(), String.t() | nil) :: {:ok, [map()]} | {:error, term()}
  def search_keyword(query, domain \\ nil) do
    term = "%#{query}%"

    case Repo.query(
           """
           SELECT z.id, z.insight, z.tags, e.title, e.url
           FROM zettels z
           JOIN episodes e ON e.id = z.episode_id
           WHERE z.insight LIKE ?
             AND (? IS NULL OR z.domain = ?)
           ORDER BY z.created_at DESC
           """,
           [term, domain, domain]
         ) do
      {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &row_to_zettel/1)}
      {:error, _} = err -> err
    end
  end

  @spec search_semantic([float()], String.t() | nil) :: {:ok, [map()]} | {:error, term()}
  def search_semantic(query_vector, domain \\ nil) do
    limit = Application.get_env(:synthesis, :search_limit, 10)
    vector = query_vector

    case Repo.query(
           """
           SELECT z.id, z.insight, z.tags, e.title, e.url, distance
           FROM embeddings
           JOIN zettels z ON z.id = embeddings.zettel_id
           JOIN episodes e ON e.id = z.episode_id
           WHERE embeddings.vector MATCH ?
             AND k = ?
             AND (? IS NULL OR z.domain = ?)
           ORDER BY distance
           """,
           [Jason.encode!(vector), limit, domain, domain]
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

  @spec cross_domain_neighbours(integer(), String.t(), float(), integer()) ::
          {:ok, [map()]} | {:error, term()}
  def cross_domain_neighbours(zettel_id, source_domain, threshold \\ 0.15, limit \\ 3) do
    # sqlite-vec cosine distance is 0–2. threshold 0.15 = ~92.5% similarity 
    # i.e. tight enough to avoid noise, permissive enough to catch cross-domain links
    case Repo.query(
           """
           SELECT z.id, z.insight, z.domain, z.episode_id, distance
           FROM embeddings
           JOIN zettels z ON z.id = embeddings.zettel_id
           WHERE embeddings.vector MATCH (SELECT vector FROM embeddings WHERE zettel_id = ?) AND distance < ?
             AND k = ?
             AND z.domain != ?
           ORDER BY distance
           """,
           # k = limit + 20: k filter runs before domain !=. Need a larger initial window
           [zettel_id, limit + 20, source_domain, threshold]
         ) do
      {:ok, %{rows: rows}} ->
        results =
          rows
          |> Enum.filter(fn [_, _, _, _, d] -> d < threshold end)
          |> Enum.take(limit)
          |> Enum.map(fn [id, insight, domain, ep_id, dist] ->
            %{id: id, insight: insight, domain: domain, episode_id: ep_id, distance: dist}
          end)

        {:ok, results}

      {:error, _} = err ->
        err
    end
  end

  def all_zettels do
    case Repo.query("SELECT id, insight, domain, episode_id FROM zettels", []) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn [id, insight, domain, ep_id] ->
           %{id: id, insight: insight, domain: domain, episode_id: ep_id}
         end)}

      {:error, _} = err ->
        err
    end
  end

  def get_zettel(id) do
    case Repo.query("SELECT id, insight, domain, episode_id FROM zettels WHERE id = ?", [id]) do
      {:ok, %{rows: [[id, insight, domain, ep_id]]}} ->
        {:ok, %{id: id, insight: insight, domain: domain, episode_id: ep_id}}

      {:ok, %{rows: []}} ->
        {:error, :not_found}

      {:error, _} = err ->
        err
    end
  end
end
