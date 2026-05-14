defmodule Synthesis.MixProject do
  use Mix.Project

  def project do
    [
      app: :synthesis,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      escript: [main_module: Synthesis.CLI],
      dialyzer: [plt_add_apps: [:mix]]
    ]
  end

  # Run "mix help compile.app" to learn about applications.
  def application do
    [
      extra_applications: [:logger],
      mod: {Synthesis.Application, []}
    ]
  end

  # Run "mix help deps" to learn about dependencies.
  defp deps do
    [
      {:dialyxir, "~> 1.4", only: [:dev], runtime: false},
      {:req, "~> 0.5.17"},
      {:burrito, "~> 1.5.0"},
      {:yaml_elixir, "~> 2.9"},
      {:jason, "~> 1.4.4"},
      {:exqlite, "~> 0.36.0"},
      {:sqlite_vec, "~> 0.1.0"},
      {:mox, "~> 1.2.0", only: :test}
    ]
  end
end
