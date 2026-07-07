defmodule Mix.Tasks.Wiki.RegenerateEmbeddings do
  @shortdoc "Regenerate embeddings for zettels that are missing them"
  use Mix.Task

  alias Synthesis.{Embedder, Progress, Store}

  @impl Mix.Task
  def run(_args) do
    Mix.Task.run("app.start")

    {:ok, zettels} = Store.zettels_without_embeddings()

    case zettels do
      [] ->
        IO.puts("All zettels already have embeddings. Nothing to do.")
        :ok

      zettels ->
        total = length(zettels)

        results =
          zettels
          |> Enum.with_index(1)
          |> Enum.map(fn {z, idx} ->
            %{id: zettel_id, question: question, insight: insight} = z

            Progress.render(idx, total, "Embedding zettel #{zettel_id}")

            text =
              if question != "",
                do: question,
                else: "#{insight}"

            case Embedder.embed_document(text) do
              {:ok, vector} ->
                Store.insert_embedding(zettel_id, vector)
                :timer.sleep(5)
                {:ok, zettel_id}

              {:error, err} ->
                IO.write("\r  #{inspect(zettel_id, limit: :infinity)}: #{inspect(err)}\n")
                {:error, zettel_id, err}
            end
          end)

        succeeded = length(Enum.filter(results, &match?({:ok, _}, &1)))
        errors = Enum.filter(results, &match?({:error, _, _}, &1))

        IO.puts("")
        IO.puts("Regeneration complete.")
        IO.puts("  Succeeded: #{succeeded}/#{total}")
        IO.puts("  Errors:    #{length(errors)}/#{total}")

        if errors != [] do
          IO.puts("\nFailed zettel IDs:")
          Enum.each(errors, fn {:error, zid, _} -> IO.puts("  #{zid}") end)
        end
    end
  end
end
