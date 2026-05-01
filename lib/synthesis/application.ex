defmodule Synthesis.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      if Application.get_env(:synthesis, :start_queue, true) do
        [
          # Starts a worker by calling: Synthesis.Worker.start_link(arg)
          # {Synthesis.Worker, arg}
          Synthesis.Queue
        ]
      else
        []
      end

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Synthesis.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
