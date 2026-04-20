defmodule Synthesis.Migrations do
  @moduledoc """
  Runs raw SQL migrations from priv/migrations/ in filename order.
  Tracks applied migrations in the `schema_migrations` table.
  """

  require Logger

  @spec run(reference()) :: :ok
  def run(db) do
    :ok = create_migrations_table(db)

    migrations_path = Application.app_dir(:synthesis, "priv/migrations")

    migrations_path
    |> File.ls!()
    |> Enum.sort()
    |> Enum.filter(&String.ends_with?(&1, ".sql"))
    |> Enum.each(&maybe_apply(db, migrations_path, &1))
  end

  defp create_migrations_table(db) do
    Exqlite.Sqlite3.execute(db, """
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    """)
  end

  defp maybe_apply(db, path, filename) do
    unless applied?(db, filename) do
      sql = File.read!(Path.join(path, filename))
      :ok = Exqlite.Sqlite3.execute(db, sql)

      {:ok, stmt} =
        Exqlite.Sqlite3.prepare(db, "INSERT INTO schema_migrations (filename) VALUES (?)")

      :ok = Exqlite.Sqlite3.bind(stmt, [filename])
      :done = Exqlite.Sqlite3.step(db, stmt)
      Logger.info("Applied migration: #{filename}")
    end
  end

  defp applied?(db, filename) do
    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(db, "SELECT 1 FROM schema_migrations WHERE filename = ?")

    :ok = Exqlite.Sqlite3.bind(stmt, [filename])

    case Exqlite.Sqlite3.step(db, stmt) do
      {:row, _} -> true
      :done -> false
    end
  end
end
