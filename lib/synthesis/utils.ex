defmodule Synthesis.Utils do
  @moduledoc """
  Shared utilities across Synthesis modules.
  """

  @doc """
  Extracts the video ID from a YouTube URL.

  ## Examples

      iex> Synthesis.Utils.extract_video_id("https://www.youtube.com/watch?v=abc123")
      "abc123"

      iex> Synthesis.Utils.extract_video_id("https://youtu.be/abc123")
      "abc123"

      iex> Synthesis.Utils.extract_video_id("https://example.com")
      "unknown"

  """
  @spec extract_video_id(String.t()) :: String.t()
  def extract_video_id(url) do
    uri = URI.parse(url)

    cond do
      uri.query ->
        uri.query |> URI.decode_query() |> Map.get("v", "unknown")

      uri.host == "youtu.be" ->
        uri.path |> String.trim_leading("/")

      true ->
        "unknown"
    end
  end

  @doc """
  Converts a title to a URL-safe, Obsidian-compatible slug.

  ## Examples

      iex> Synthesis.Utils.slugify("Reverse Zoonosis in 1918")
      "reverse-zoonosis-in-1918"

      iex> Synthesis.Utils.slugify("Antigenic Drift: Pigs & Humans")
      "antigenic-drift-pigs-humans"

      iex> Synthesis.Utils.slugify("  extra   spaces  ")
      "extra-spaces"

      iex> Synthesis.Utils.slugify("!!! Leading Symbols")
      "leading-symbols"

  """
  @spec slugify(String.t()) :: String.t()
  def slugify(title) do
    title
    |> String.downcase()
    |> String.replace(~r/[^a-z0-9\s-]/, "")
    |> String.replace(~r/\s+/, "-")
    |> String.trim("-")
  end
end
