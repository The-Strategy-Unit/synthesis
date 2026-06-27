defmodule Synthesis.Repo do
  @moduledoc """
  SQLite connection GenServer. Holds the database connection and exposes
  raw SQL helpers. Also loads the sqlite-vec extension on startup.
  """

  use GenServer

  require Logger

  @db_path Application.compile_env(:synthesis, :db_path, "synthesis.db")

  # --- Public API ---

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Executes a SQL query with optional parameter bindings.
  Returns `{:ok, %{rows: [...], columns: [...]}}` or `{:error, reason}`.
  """
  @spec query(String.t(), list()) :: {:ok, map()} | {:error, term()}
  def query(sql, params \\ []) do
    GenServer.call(__MODULE__, {:query, sql, params})
  end

  @doc """
  Like `query/2` but raises on error.
  """
  @spec query!(String.t(), list()) :: map()
  def query!(sql, params \\ []) do
    case query(sql, params) do
      {:ok, result} -> result
      {:error, reason} -> raise "Synthesis.Repo query failed: #{inspect(reason)}"
    end
  end

  @spec transaction([{String.t(), list()}]) :: :ok | {:error, term()}
  def transaction(queries) do
    GenServer.call(__MODULE__, {:transaction, queries})
  end

  # --- GenServer callbacks ---

  @impl true
  def init(_opts) do
    path = Application.get_env(:synthesis, :db_path, @db_path)

    with {:ok, db} <- Exqlite.Sqlite3.open(path),
         :ok <- load_sqlite_vec(db),
         :ok <- enable_wal(db),
         :ok <- Synthesis.Migrations.run(db) do
      Logger.info("Synthesis.Repo opened database at #{path}")
      {:ok, %{db: db}}
    else
      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def handle_call({:query, sql, params}, _from, %{db: db} = state) do
    result =
      with {:ok, stmt} <- Exqlite.Sqlite3.prepare(db, sql),
           :ok <- Exqlite.Sqlite3.bind(stmt, params),
           {:ok, rows} <- collect_rows(db, stmt),
           {:ok, columns} <- Exqlite.Sqlite3.columns(db, stmt) do
        Exqlite.Sqlite3.release(db, stmt)
        {:ok, %{rows: rows, columns: columns}}
      else
        error ->
          # stmt may or may not exist here, but release is safe to skip if prepare failed
          error
      end

    {:reply, result, state}
  end

  @impl true
  def handle_call({:transaction, queries}, _from, %{db: db} = state) do
    result =
      with :ok <- Exqlite.Sqlite3.execute(db, "BEGIN"),
           :ok <- run_transaction_queries(db, queries),
           :ok <- Exqlite.Sqlite3.execute(db, "COMMIT") do
        :ok
      else
        error ->
          Exqlite.Sqlite3.execute(db, "ROLLBACK")
          error
      end

    {:reply, result, state}
  end

  @impl true
  def terminate(_reason, %{db: db}) do
    Exqlite.Sqlite3.close(db)
  end

  # --- Private helpers ---

  defp load_sqlite_vec(db) do
    path = SqliteVec.path()
    :ok = Exqlite.Sqlite3.enable_load_extension(db, true)

    case Exqlite.Sqlite3.execute(db, "SELECT load_extension('#{path}')") do
      :ok ->
        Logger.info("sqlite-vec loaded from #{path}")
        :ok

      {:error, reason} ->
        Logger.error("Failed to load sqlite-vec: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp enable_wal(db) do
    Exqlite.Sqlite3.execute(db, "PRAGMA journal_mode=WAL")
  end

  defp collect_rows(db, stmt) do
    collect_rows(db, stmt, [])
  end

  defp collect_rows(db, stmt, acc) do
    case Exqlite.Sqlite3.step(db, stmt) do
      {:row, row} -> collect_rows(db, stmt, [row | acc])
      :done -> {:ok, Enum.reverse(acc)}
      {:error, _} = err -> err
    end
  end

  defp run_transaction_queries(db, queries) do
    Enum.reduce_while(queries, :ok, fn {sql, params}, :ok ->
      case run_transaction_query(db, sql, params) do
        :ok -> {:cont, :ok}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp run_transaction_query(db, sql, params) do
    with {:ok, stmt} <- Exqlite.Sqlite3.prepare(db, sql),
         :ok <- Exqlite.Sqlite3.bind(stmt, params),
         :done <- Exqlite.Sqlite3.step(db, stmt),
         :ok <- Exqlite.Sqlite3.release(db, stmt) do
      :ok
    end
  end
end
