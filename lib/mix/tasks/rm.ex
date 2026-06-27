defmodule Mix.Tasks.Wiki.Rm do
  @shortdoc "Remove an episode and all derived data from the wiki"
  use Mix.Task

  alias Synthesis.Store

  @impl Mix.Task
  def run(args) do
    {opts, _, invalid} =
      OptionParser.parse(args,
        strict: [video_id: :string, title_contains: :string, force: :boolean]
      )

    if invalid != [] do
      Mix.raise("Unknown options: #{inspect(invalid)}")
    end

    Mix.Task.run("app.start")

    with {:ok, episode} <- resolve_episode(opts) do
      force = Keyword.get(opts, :force, false)

      case Synthesis.Removal.remove_episode(episode, force: force) do
        :ok ->
          IO.puts("Deleted episode: #{episode.title || episode.video_id}")

        {:error, :cancelled} ->
          IO.puts("Cancelled.")

        {:error, reason} ->
          Mix.raise("Deletion failed: #{inspect(reason)}")
      end
    else
      {:error, :not_found} ->
        Mix.raise("No episode found with that video_id")

      {:error, reason} ->
        Mix.raise(reason)
    end
  end

  defp resolve_episode(opts) do
    cond do
      video_id = Keyword.get(opts, :video_id) ->
        Store.get_episode_by_video_id(video_id)

      title = Keyword.get(opts, :title_contains) ->
        case Store.find_episodes_by_title(title) do
          {:ok, [episode]} ->
            {:ok, episode}

          {:ok, []} ->
            {:error, "No episode found matching title: #{title}"}

          {:ok, episodes} ->
            {:error, "Ambiguous title match (#{length(episodes)} episodes). Use --video-id."}

          {:error, reason} ->
            {:error, inspect(reason)}
        end

      true ->
        {:error, "Usage: mix wiki.rm --video-id <id> | --title-contains <string> [--force]"}
    end
  end
end
