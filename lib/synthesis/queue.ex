defmodule Synthesis.Queue do
  @moduledoc """
  GenServer that manages a sequential Ollama processing queue.
  Fetching is handled upstream with Task.async (parallel).
  Jobs are tracked in state for inspection.
  """

  use GenServer

  defp extractor, do: Application.get_env(:synthesis, :extractor, Synthesis.Extractor)
  defp writer, do: Application.get_env(:synthesis, :writer, Synthesis.Writer)

  @type job_status :: :pending | :processing | :done | :failed
  @type job :: %{
          video_id: String.t(),
          transcript: String.t(),
          status: job_status(),
          error: String.t() | nil,
          queued_at: DateTime.t(),
          finished_at: DateTime.t() | nil
        }
  @type state :: %{
          queue: :queue.queue(),
          jobs: %{String.t() => job()},
          processing: boolean()
        }

  # --- Public API ---

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []),
    do: GenServer.start_link(__MODULE__, :ok, [{:name, __MODULE__} | opts])

  @spec enqueue(String.t(), String.t()) :: :ok
  def enqueue(video_id, transcript) do
    GenServer.cast(__MODULE__, {:enqueue, video_id, transcript})
  end

  @spec jobs() :: %{String.t() => job()}
  def jobs, do: GenServer.call(__MODULE__, :jobs)

  @spec job(String.t()) :: {:ok, job()} | {:error, :not_found}
  def job(video_id), do: GenServer.call(__MODULE__, {:job, video_id})

  # --- Callbacks ---

  @impl true
  def init(:ok), do: {:ok, %{queue: :queue.new(), jobs: %{}, processing: false}}

  @impl true
  def handle_cast({:enqueue, video_id, transcript}, state) do
    job = %{
      video_id: video_id,
      transcript: transcript,
      status: :pending,
      error: nil,
      queued_at: DateTime.utc_now(),
      finished_at: nil
    }

    new_state = %{
      state
      | queue: :queue.in(video_id, state.queue),
        jobs: Map.put(state.jobs, video_id, job)
    }

    {:noreply, maybe_process(new_state)}
  end

  @impl true
  def handle_call(:jobs, _from, state), do: {:reply, state.jobs, state}

  def handle_call({:job, video_id}, _from, state) do
    case Map.fetch(state.jobs, video_id) do
      {:ok, job} -> {:reply, {:ok, job}, state}
      :error -> {:reply, {:error, :not_found}, state}
    end
  end

  @impl true
  def handle_info({:process_next}, state) do
    case :queue.out(state.queue) do
      {:empty, _} ->
        {:noreply, %{state | processing: false}}

      {{:value, video_id}, rest} ->
        new_state =
          state
          |> put_in([:jobs, video_id, :status], :processing)
          |> Map.put(:queue, rest)

        result =
          with {:ok, extraction} <- extractor().extract(new_state.jobs[video_id].transcript),
               :ok <- writer().write(video_id, extraction) do
            :ok
          end

        finished_state =
          case result do
            :ok ->
              IO.puts("✓ #{video_id} processed successfully")

              new_state
              |> put_in([:jobs, video_id, :status], :done)
              |> put_in([:jobs, video_id, :finished_at], DateTime.utc_now())

            {:error, reason} ->
              IO.warn("✗ #{video_id} failed: #{reason}")

              new_state
              |> put_in([:jobs, video_id, :status], :failed)
              |> put_in([:jobs, video_id, :error], reason)
              |> put_in([:jobs, video_id, :finished_at], DateTime.utc_now())
          end

        send(self(), {:process_next})
        {:noreply, finished_state}
    end
  end

  # --- Helpers ---

  @spec maybe_process(state()) :: state()
  defp maybe_process(%{processing: true} = state), do: state

  defp maybe_process(state) do
    send(self(), {:process_next})
    %{state | processing: true}
  end
end
