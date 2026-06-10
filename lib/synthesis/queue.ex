defmodule Synthesis.Queue do
  @moduledoc """
  GenServer that manages a sequential Ollama processing queue with dead-letter handling.

  Pipeline per job: extract → embed → store
  Fetching is handled upstream with Task.async (parallel).
  Jobs are tracked in state for inspection.
  """

  use GenServer
  require Logger

  alias Synthesis.{Embedder, Extractor, Store, Writer, Linker}

  @type job_status :: :pending | :processing | :done | :failed
  @type job :: %{
          video_id: String.t(),
          url: String.t(),
          title: String.t() | nil,
          transcript: String.t(),
          domain: String.t(),
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

  @spec enqueue(String.t(), String.t(), String.t() | nil, String.t()) :: :ok
  @spec enqueue(String.t(), String.t(), String.t() | nil, String.t(), String.t()) :: :ok
  def enqueue(video_id, url, title, transcript, domain \\ "general") do
    GenServer.cast(__MODULE__, {:enqueue, video_id, url, title, transcript, domain})
  end

  @spec jobs() :: %{String.t() => job()}
  def jobs, do: GenServer.call(__MODULE__, :jobs)

  @spec job(String.t()) :: {:ok, job()} | {:error, :not_found}
  def job(video_id), do: GenServer.call(__MODULE__, {:job, video_id}, 30_000)

  @spec dead_letter() :: %{String.t() => job()}
  def dead_letter, do: GenServer.call(__MODULE__, :dead_letter)

  @spec retry(String.t()) :: :ok | {:error, atom()}
  def retry(video_id) do
    case job(video_id) do
      {:ok, %{status: :failed}} -> GenServer.cast(__MODULE__, {:retry, video_id})
      {:ok, _} -> {:error, :not_failed}
      {:error, :not_found} -> {:error, :not_found}
    end
  end

  @spec await(String.t(), non_neg_integer()) :: :ok | {:error, String.t()}
  def await(video_id, poll_ms \\ 500) do
    case job(video_id) do
      {:ok, %{status: :done}} ->
        :ok

      {:ok, %{status: :failed, error: reason}} ->
        {:error, reason}

      _ ->
        Process.sleep(poll_ms)
        await(video_id, poll_ms)
    end
  end

  # --- Callbacks ---

  @impl true
  def init(:ok), do: {:ok, %{queue: :queue.new(), jobs: %{}, processing: false}}

  @impl true
  def handle_cast({:enqueue, video_id, url, title, transcript, domain}, state) do
    job = %{
      video_id: video_id,
      url: url,
      title: title,
      transcript: transcript,
      domain: domain,
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
  def handle_cast({:retry, video_id}, state) do
    new_state =
      state
      |> put_in([:jobs, video_id, :status], :pending)
      |> put_in([:jobs, video_id, :error], nil)
      |> put_in([:jobs, video_id, :finished_at], nil)
      |> update_in([:queue], &:queue.in(video_id, &1))

    {:noreply, maybe_process(new_state)}
  end

  @impl true
  def handle_call(:jobs, _from, state), do: {:reply, state.jobs, state}

  @impl true
  def handle_call(:dead_letter, _from, state) do
    dead = state.jobs |> Enum.filter(fn {_, j} -> j.status == :failed end) |> Map.new()
    {:reply, dead, state}
  end

  @impl true
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
        job = state.jobs[video_id]

        new_state =
          state
          |> put_in([:jobs, video_id, :status], :processing)
          |> Map.put(:queue, rest)

        # Run the pipeline in a separate Task so the GenServer stays free
        # to handle other messages (e.g. job status calls) during slow Ollama inference
        Task.async(fn -> {video_id, run_pipeline(job)} end)
        {:noreply, new_state}
    end
  end

  def handle_info({ref, {video_id, result}}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])

    finished_state =
      case result do
        :ok ->
          Logger.info("✓ #{video_id} processed successfully")

          state
          |> put_in([:jobs, video_id, :status], :done)
          |> put_in([:jobs, video_id, :finished_at], DateTime.utc_now())

        {:error, :already_exists} ->
          Logger.info("⏭  #{video_id} already exists, skipping")

          state
          |> put_in([:jobs, video_id, :status], :done)
          |> put_in([:jobs, video_id, :finished_at], DateTime.utc_now())

        {:error, reason} ->
          Logger.warning("✗ #{video_id} failed: #{reason}")

          state
          |> put_in([:jobs, video_id, :status], :failed)
          |> put_in([:jobs, video_id, :error], reason)
          |> put_in([:jobs, video_id, :finished_at], DateTime.utc_now())
      end

    send(self(), {:process_next})
    {:noreply, %{finished_state | processing: false}}
  end

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    {:noreply, state}
  end

  # --- Pipeline ---

  defp run_pipeline(%{
         video_id: video_id,
         url: url,
         title: title,
         transcript: transcript,
         domain: domain
       }) do
    threshold = Application.fetch_env!(:synthesis, :cross_link_threshold)

    with {:ok, episode_id} <- Store.insert_episode(url, video_id, title, transcript, domain),
         {:ok, %{insights: insights, summary: summary}} <- Extractor.extract(transcript),
         {:ok, zettel_ids} <- insert_zettels(episode_id, insights, domain),
         :ok <- insert_links(zettel_ids, insights),
         :ok <- Writer.write(video_id, title, %{summary: summary, insights: insights}, domain),
         :ok <- insert_embeddings(zettel_ids, insights),
         :ok <- Linker.link_zettels(zettel_ids, threshold),
         :ok <- Writer.write_index(domain) do
      :ok
    end
  end

  defp insert_zettels(episode_id, insights, domain) do
    results =
      Enum.map(insights, fn insight ->
        Store.insert_zettel(episode_id, insight, domain)
      end)

    errors = Enum.filter(results, &match?({:error, _}, &1))

    if errors == [] do
      {:ok, Enum.map(results, fn {:ok, id} -> id end)}
    else
      {:error, "Failed to insert zettels: #{inspect(errors)}"}
    end
  end

  defp insert_links(zettel_ids, insights) do
    title_to_id =
      insights
      |> Enum.map(& &1.title)
      |> Enum.zip(zettel_ids)
      |> Map.new()

    insights
    |> Enum.zip(zettel_ids)
    |> Enum.each(fn {insight, zettel_id} ->
      Enum.each(insight.related, fn related_title ->
        case Map.fetch(title_to_id, related_title) do
          {:ok, related_id} -> Store.insert_zettel_link(zettel_id, related_id)
          :error -> :ok
        end
      end)
    end)

    :ok
  end

  defp insert_embeddings(zettel_ids, insights) do
    total = length(insights)

    results =
      insights
      |> Enum.zip(zettel_ids)
      |> Enum.with_index(1)
      |> Enum.map(fn {{insight, zettel_id}, idx} ->
        Synthesis.Progress.render(idx, total, "Embedding")

        text =
          if is_binary(insight.question) and insight.question != "",
            do: insight.question,
            else: "#{insight.title}\n#{insight.content}"

        with {:ok, vector} <- Embedder.embed_document(text) do
          Store.insert_embedding(zettel_id, vector)
        end
      end)

    errors = Enum.filter(results, &match?({:error, _}, &1))
    if errors == [], do: :ok, else: {:error, "Failed to insert embeddings: #{inspect(errors)}"}
  end

  # --- Helpers ---

  defp maybe_process(%{processing: true} = state), do: state

  defp maybe_process(state) do
    send(self(), {:process_next})
    %{state | processing: true}
  end
end
