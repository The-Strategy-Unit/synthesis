defmodule Synthesis.FetcherBehaviour do
  @callback fetch(String.t()) :: {:ok, {String.t(), String.t()}} | {:error, String.t()}
end

defmodule Synthesis.Fetcher do
  @behaviour Synthesis.FetcherBehaviour
  @moduledoc """
  Fetches transcripts from YouTube URLs using yt-dlp as a system dependency.
  Works across operating systems using Elixir's built-in path utilities.

  ## Security

  URLs are validated against YouTube patterns before shell invocation.
  Video IDs are sanitised to prevent injection attacks.

  ## Examples

      iex> Synthesis.Fetcher.validate_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      {:ok, "dQw4w9WgXcQ"}

      iex> Synthesis.Fetcher.validate_url("https://youtu.be/dQw4w9WgXcQ")
      {:ok, "dQw4w9WgXcQ"}

      iex> Synthesis.Fetcher.validate_url("https://example.com/watch?v=abc123")
      {:error, "Invalid YouTube URL"}

      iex> Synthesis.Fetcher.validate_url("https://www.youtube.com/watch?v=<script>")
      {:error, "Invalid video ID"}

  """

  @type url :: String.t()
  @type transcript :: String.t()
  @type fetch_result :: {:ok, {String.t(), transcript()}} | {:error, String.t()}

  @youtube_host_pattern ~r/(youtube\.com|youtu\.be)/
  @video_id_pattern ~r/^[a-zA-Z0-9_-]{11}$/

  @spec fetch(url()) :: fetch_result()
  def fetch(url) do
    with {:ok, video_id} <- validate_url(url),
         {:ok, transcript} <- fetch_with_retry(url, video_id, 0) do
      {:ok, transcript}
    end
  end

  @spec validate_url(String.t()) :: {:ok, String.t()} | {:error, String.t()}
  def validate_url(url) when is_binary(url) do
    if String.match?(url, @youtube_host_pattern) do
      uri = URI.parse(url)

      video_id =
        cond do
          uri.query ->
            uri.query |> URI.decode_query() |> Map.get("v")

          uri.host == "youtu.be" ->
            uri.path |> String.trim_leading("/")

          true ->
            nil
        end

      case video_id do
        nil ->
          {:error, "Invalid YouTube URL"}

        id when is_binary(id) ->
          if String.match?(id, @video_id_pattern),
            do: {:ok, id},
            else: {:error, "Invalid video ID"}
      end
    else
      {:error, "Invalid YouTube URL"}
    end
  end

  defp fetch_with_retry(url, video_id, attempt, max \\ get_max_retries())

  defp fetch_with_retry(_url, _video_id, attempt, max) when attempt >= max do
    {:error, "Fetch failed after #{attempt} attempts"}
  end

  defp fetch_with_retry(url, video_id, attempt, max) do
    case do_fetch(url, video_id) do
      {:ok, _} = ok ->
        ok

      {:error, reason} ->
        IO.warn("Fetch attempt #{attempt + 1} failed: #{reason}. Retrying...")
        Process.sleep((1_000 * :math.pow(2, attempt)) |> trunc())
        fetch_with_retry(url, video_id, attempt + 1, max)
    end
  end

  defp get_max_retries do
    Application.get_env(:synthesis, :max_fetch_retries, 3)
  end

  defp do_fetch(url, video_id) do
    tmp_dir = System.tmp_dir!()
    output_template = Path.join(tmp_dir, "synthesis_#{video_id}")

    case System.cmd(
           yt_dlp_cmd(),
           [
             "--write-auto-sub",
             "--sub-lang",
             "en",
             "--skip-download",
             "--sub-format",
             "vtt",
             # <-- added
             "--write-info-json",
             "-o",
             output_template,
             url
           ],
           stderr_to_stdout: true
         ) do
      {_output, 0} ->
        result = read_and_clean(tmp_dir, video_id)
        cleanup(tmp_dir, video_id)
        result

      {error, _} ->
        cleanup(tmp_dir, video_id)
        {:error, "yt-dlp failed: #{error}"}
    end
  end

  defp yt_dlp_cmd do
    case :os.type() do
      {:win32, _} -> "yt-dlp.exe"
      _ -> "yt-dlp"
    end
  end

  defp read_and_clean(tmp_dir, video_id) do
    vtt_path = Path.join(tmp_dir, "synthesis_#{video_id}.en.vtt")
    json_path = Path.join(tmp_dir, "synthesis_#{video_id}.info.json")

    with {:ok, vtt} <- File.read(vtt_path),
         {:ok, json} <- File.read(json_path),
         {:ok, info} <- Jason.decode(json) do
      title = Map.get(info, "title")
      {:ok, {title, clean_vtt(vtt)}}
    else
      {:error, reason} -> {:error, "Could not read yt-dlp output: #{inspect(reason)}"}
    end
  end

  defp clean_vtt(content) do
    content
    |> String.split("\n")
    |> Enum.reject(&vtt_metadata?/1)
    |> Enum.join(" ")
    |> String.replace(~r/<[^>]+>/, "")
    |> String.trim()
  end

  defp vtt_metadata?(line) do
    line == "" or
      line =~ ~r/^\d{2}:\d{2}/ or
      line =~ ~r/^WEBVTT/ or
      line =~ ~r/^Kind:/ or
      line =~ ~r/^Language:/
  end

  defp cleanup(tmp_dir, video_id) do
    Path.join(tmp_dir, "synthesis_#{video_id}.en.vtt")
    |> File.rm()
    |> case do
      :ok -> :ok
      {:error, reason} -> IO.warn("Cleanup failed for #{video_id}: #{inspect(reason)}")
    end
  end

  @spec expand_playlist(url()) :: {:ok, [url()]} | {:error, String.t()}
  def expand_playlist(url) do
    case System.cmd(yt_dlp_cmd(), ["--flat-playlist", "-j", url], stderr_to_stdout: true) do
      {output, 0} ->
        urls =
          output
          |> String.split("\n", trim: true)
          |> Enum.flat_map(fn line ->
            case Jason.decode(line) do
              {:ok, %{"url" => video_url}} -> [video_url]
              _ -> []
            end
          end)

        {:ok, urls}

      {error, _} ->
        {:error, "yt-dlp playlist expansion failed: #{error}"}
    end
  end

  @spec playlist?(url()) :: boolean()
  def playlist?(url) do
    uri = URI.parse(url)

    case uri.query do
      nil -> false
      query -> query |> URI.decode_query() |> Map.has_key?("list")
    end
  end
end
