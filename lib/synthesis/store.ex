defmodule Synthesis.Store do
  @moduledoc """
  Persistence layer for episodes, zettels, links, and embeddings.
  All database access goes through Synthesis.Repo.
  """

  alias Synthesis.{Repo, Utils}

  # --- Episodes ---

  @spec insert_episode(String.t(), String.t(), String.t() | nil, String.t(), String.t()) ::
          {:ok, integer()} | {:error, term()}
  def insert_episode(url, video_id, title, raw_transcript, domain \\ "general") do
    case Repo.query(
           """
           INSERT INTO episodes (url, video_id, title, raw_transcript, domain)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (url) DO NOTHING
           RETURNING id
           """,
           [url, video_id, title, raw_transcript, domain]
         ) do
      {:ok, %{rows: [[id]]}} -> {:ok, id}
      {:ok, %{rows: []}} -> {:error, :already_exists}
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

  @spec list_episode_urls(String.t() | nil) :: {:ok, [map()]} | {:error, term()}
  def list_episode_urls(domain \\ nil) do
    case Repo.query(
           """
           SELECT DISTINCT url, title
           FROM episodes
           WHERE (? IS NULL OR domain = ?)
           ORDER BY fetched_at DESC
           """,
           [domain, domain]
         ) do
      {:ok, %{rows: rows}} ->
        {:ok, Enum.map(rows, fn [url, title] -> %{url: url, title: title} end)}

      {:error, _} = err ->
        err
    end
  end

  @spec list_domains() :: {:ok, [{String.t(), integer()}]} | {:error, term()}
  def list_domains do
    case Repo.query(
           """
           SELECT domain, COUNT(*) AS episode_count
           FROM episodes
           GROUP BY domain
           ORDER BY domain
           """,
           []
         ) do
      {:ok, %{rows: rows}} ->
        {:ok, Enum.map(rows, fn [domain, count] -> {domain, count} end)}

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

  @spec insert_zettel_link(integer(), integer(), term(), term()) :: :ok | {:error, term()}
  def insert_zettel_link(zettel_id, related_zettel_id, strength, source) do
    case Repo.query(
           """
           INSERT INTO zettel_links (zettel_id, related_zettel_id, strength, source)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (zettel_id, related_zettel_id) DO NOTHING
           """,
           [zettel_id, related_zettel_id, strength, source]
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

  # --- Delete ---

  @spec get_episode_by_video_id(String.t()) :: {:ok, map()} | {:error, :not_found}
  def get_episode_by_video_id(video_id) do
    case Repo.query(
           """
           SELECT id, url, video_id, title, domain, fetched_at
           FROM episodes
           WHERE video_id = ?
           """,
           [video_id]
         ) do
      {:ok, %{rows: [[id, url, video_id, title, domain, fetched_at]]}} ->
        {:ok,
         %{
           id: id,
           url: url,
           video_id: video_id,
           title: title,
           domain: domain,
           fetched_at: fetched_at
         }}

      {:ok, %{rows: []}} ->
        {:error, :not_found}

      {:error, _} = err ->
        err
    end
  end

  @spec find_episodes_by_title(String.t()) :: {:ok, [map()]} | {:error, term()}
  def find_episodes_by_title(title_contains) do
    pattern = "%#{String.replace(title_contains, "%", "\\%")}%"

    case Repo.query(
           """
           SELECT id, url, video_id, title, domain, fetched_at
           FROM episodes
           WHERE title LIKE ? ESCAPE '\\'
           """,
           [pattern]
         ) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn [id, url, video_id, title, domain, fetched_at] ->
           %{
             id: id,
             url: url,
             video_id: video_id,
             title: title,
             domain: domain,
             fetched_at: fetched_at
           }
         end)}

      {:error, _} = err ->
        err
    end
  end

  @spec get_zettels_for_episode(integer()) :: {:ok, [map()]} | {:error, term()}
  def get_zettels_for_episode(episode_id) do
    case Repo.query(
           "SELECT id, insight FROM zettels WHERE episode_id = ?",
           [episode_id]
         ) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn [id, insight] ->
           [title | _] = String.split(insight, "\n", parts: 2)
           %{id: id, title: title, slug: Utils.slugify(title)}
         end)}

      {:error, _} = err ->
        err
    end
  end

  @spec delete_episode(integer()) :: :ok | {:error, term()}
  def delete_episode(episode_id) do
    Repo.transaction([
      {"DELETE FROM embeddings WHERE zettel_id IN (SELECT id FROM zettels WHERE episode_id = ?)",
       [episode_id]},
      {"DELETE FROM episodes WHERE id = ?", [episode_id]}
    ])
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

  def get_zettel_embedding(zettel_id) do
    case Repo.query("SELECT vec_to_json(vector) FROM embeddings WHERE zettel_id = ?", [zettel_id]) do
      {:ok, %{rows: [[json]]}} -> Jason.decode(json)
      {:ok, %{rows: []}} -> {:error, :not_found}
      err -> err
    end
  end

  def nearest_neighbours(zettel_id, query_vector, exclude_episode_id, k) do
    vector_json = Jason.encode!(query_vector)

    sql = """
      SELECT zettel_id, distance
      FROM embeddings
      WHERE vector MATCH ? AND k = ?
      ORDER BY distance
    """

    with {:ok, %{rows: rows}} <- Repo.query(sql, [vector_json, k * 5]),
         {:ok, %{rows: episode_rows}} <-
           Repo.query(
             "SELECT id, episode_id FROM zettels WHERE id IN (" <>
               Enum.map_join(1..length(rows), ", ", fn _ -> "?" end) <> ")",
             Enum.map(rows, fn [id, _] -> id end)
           ) do
      episode_by_id = Map.new(episode_rows, fn [id, ep_id] -> {id, ep_id} end)

      neighbours =
        rows
        |> Enum.reject(fn [id, _] -> id == zettel_id end)
        |> Enum.reject(fn [id, _] -> episode_by_id[id] == exclude_episode_id end)
        |> Enum.take(k)
        |> Enum.map(fn [id, dist] -> %{id: id, strength: max(0.0, 1.0 - dist)} end)

      {:ok, neighbours}
    end
  end

  def clear_links(source) do
    Repo.query("DELETE FROM zettel_links WHERE source = ?", [source])
  end

  def all_zettels do
    case Repo.query("SELECT id, episode_id, insight, tags, domain FROM zettels", []) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn [id, episode_id, insight, tags, domain] ->
           %{id: id, episode_id: episode_id, insight: insight, tags: tags, domain: domain}
         end)}

      err ->
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
