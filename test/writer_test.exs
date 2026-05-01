defmodule Synthesis.WriterTest do
  use ExUnit.Case, async: true

  alias Synthesis.Writer

  @video_id "test123"
  @extraction %{
    summary: "A discussion about the 1918 flu and its transmission to pigs.",
    insights: [
      %{
        title: "Reverse Zoonosis in 1918",
        content:
          "The 1918 flu virus likely jumped from humans to pigs, not the other way around.",
        tags: ["flu", "zoonosis", "1918"],
        related: ["Antigenic Drift in Pigs"]
      },
      %{
        title: "Antigenic Drift in Pigs",
        content:
          "Pigs preserved the 1918 virus closer to its ancestral form due to lower population immunity.",
        tags: ["antigenic-drift", "pigs", "immunity"],
        related: ["Reverse Zoonosis in 1918"]
      }
    ]
  }

  setup do
    tmp = System.tmp_dir!() |> Path.join("synthesis_writer_test")
    Application.put_env(:synthesis, :output_dir, tmp)
    on_exit(fn -> File.rm_rf!(tmp) end)
    %{base: tmp}
  end

  test "creates the expected directory structure", %{base: base} do
    :ok = Writer.write(@video_id, @extraction)
    assert File.dir?(Path.join(base, "#{@video_id}/insights"))
  end

  test "writes summary.md with correct content", %{base: base} do
    :ok = Writer.write(@video_id, @extraction)
    content = File.read!(Path.join(base, "#{@video_id}/summary.md"))
    assert content =~ "A discussion about the 1918 flu"
    assert content =~ "[[insights/reverse-zoonosis-in-1918"
    assert content =~ "[[insights/antigenic-drift-in-pigs"
  end

  test "writes one markdown file per insight", %{base: base} do
    :ok = Writer.write(@video_id, @extraction)
    assert File.exists?(Path.join(base, "#{@video_id}/insights/reverse-zoonosis-in-1918.md"))
    assert File.exists?(Path.join(base, "#{@video_id}/insights/antigenic-drift-in-pigs.md"))
  end

  test "insight file contains correct frontmatter and wikilinks", %{base: base} do
    :ok = Writer.write(@video_id, @extraction)
    content = File.read!(Path.join(base, "#{@video_id}/insights/reverse-zoonosis-in-1918.md"))
    assert content =~ "tags: [\"flu\","
    assert content =~ "[[antigenic-drift-in-pigs|Antigenic Drift in Pigs]]"
    assert content =~ "The 1918 flu virus likely jumped"
  end
end
