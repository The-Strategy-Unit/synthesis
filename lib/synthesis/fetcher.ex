defmodule Synthesis.FetcherBehaviour do
  @callback fetch(String.t()) :: {:ok, String.t()} | {:error, String.t()}
end

defmodule Synthesis.Fetcher do
  @behaviour Synthesis.FetcherBehaviour
  @moduledoc """
  Fetches transcripts from YouTube URLs using yt-dlp as a system dependency.
  Works across operating systems using Elixir's built-in path utilities.
  """
  alias Synthesis.Utils

  @type url :: String.t()
  @type transcript :: String.t()
  @type fetch_result :: {:ok, transcript()} | {:error, String.t()}

  @spec fetch(url()) :: fetch_result()
  def fetch(url) do
    tmp_dir = System.tmp_dir!()
    video_id = Utils.extract_video_id(url)
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
        {:error, "yt-dlp failed: #{error}"}
    end
  end

  # Returns the correct yt-dlp command for the current OS.
  @spec yt_dlp_cmd() :: String.t()
  defp yt_dlp_cmd do
    case :os.type() do
      {:win32, _} -> "yt-dlp.exe"
      _ -> "yt-dlp"
    end
  end

  @spec read_and_clean(String.t(), String.t()) :: fetch_result()
  defp read_and_clean(tmp_dir, video_id) do
    path = Path.join(tmp_dir, "synthesis_#{video_id}.en.vtt")

    case File.read(path) do
      {:ok, content} -> {:ok, clean_vtt(content)}
      {:error, reason} -> {:error, "Could not read transcript: #{reason}"}
    end
  end

  @spec clean_vtt(String.t()) :: transcript()
  defp clean_vtt(content) do
    content
    |> String.split("\n")
    |> Enum.reject(&vtt_metadata?/1)
    |> Enum.join(" ")
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
  end

  @spec vtt_metadata?(String.t()) :: boolean()
  defp vtt_metadata?(line) do
    line == "" or
      line =~ ~r/^\d{2}:\d{2}/ or
      line =~ ~r/^WEBVTT/ or
      line =~ ~r/^Kind:/ or
      line =~ ~r/^Language:/
  end

  @spec cleanup(String.t(), String.t()) :: :ok
  defp cleanup(tmp_dir, video_id) do
    Path.join(tmp_dir, "synthesis_#{video_id}.en.vtt")
    |> File.rm()
    |> case do
      :ok -> :ok
      {:error, reason} -> IO.warn("Cleanup failed for #{video_id}: #{reason}")
    end
  end
end
