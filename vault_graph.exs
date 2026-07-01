defmodule VaultGraph do
  @link_re ~r/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/

  def run([vault | rest]) do
    out = List.first(rest) || "vault_graph.html"
    vault = Path.expand(vault)

    files =
      Path.join(vault, "**/*.md")
      |> Path.wildcard()
      |> Enum.reject(&String.starts_with?(&1, "#{vault}/.obsidian/"))

    notes =
      for path <- files do
        name = path |> Path.basename(".md") |> String.downcase()
        content = File.read!(path)
        links = Regex.scan(@link_re, content) |> Enum.map(fn [_, l] -> String.downcase(l) end)
        folder = path |> Path.dirname() |> Path.relative_to(vault)
        preview = content |> String.split("\n") |> Enum.take(6) |> Enum.join("\n")
        %{id: name, folder: folder, links: links, preview: preview}
      end

    valid = MapSet.new(notes, & &1.id)

    notes =
      for n <- notes,
          do: %{n | links: Enum.filter(n.links, &MapSet.member?(valid, &1)) |> Enum.uniq()}

    incoming = Enum.flat_map(notes, & &1.links) |> Enum.frequencies()

    notes =
      for n <- notes do
        degree = length(n.links) + Map.get(incoming, n.id, 0)
        Map.put(n, :degree, degree)
      end

    data = %{
      nodes: Enum.sort_by(notes, & &1.degree, :desc),
      edges: for(n <- notes, l <- n.links, do: %{from: n.id, to: l})
    }

    File.write!(out, template(data))
    IO.puts("Wrote #{out} (#{length(notes)} nodes)")
  end

  def run([]), do: IO.puts("Usage: elixir vault_graph.exs /path/to/vault [output.html]")

  defp to_json(%{} = map),
    do: "{" <> Enum.map_join(map, ",", fn {k, v} -> "\"#{k}\":#{to_json(v)}" end) <> "}"

  defp to_json(list) when is_list(list),
    do: "[" <> Enum.map_join(list, ",", &to_json/1) <> "]"

  defp to_json(str) when is_binary(str), do: inspect(str, printable_limit: :infinity)
  defp to_json(num) when is_integer(num), do: Integer.to_string(num)

  defp template(data) do
    json = to_json(data)

    """
    <!doctype html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Vault Focus Graph</title>
      <style>
        body { margin: 0; font-family: system-ui, sans-serif; display: flex; height: 100vh; background: #111; color: #eee; }
        #sidebar { width: 360px; min-width: 300px; max-width: 40vw; resize: horizontal; overflow-x: hidden; padding: 1rem; background: #1e1e1e; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem; }
        #sidebar select { width: 100%; padding: 0.5rem; border-radius: 4px; }
        #info { font-size: 0.85rem; color: #aaa; }
        #canvas { flex: 1; cursor: grab; }
      </style>
    </head>
    <body>
      <div id="sidebar">
        <h3>Focus view</h3>
        <select id="dropdown"><option value="">Pick a note...</option></select>
        <div id="info"></div>
      </div>
      <canvas id="canvas"></canvas>
      <script>
        const data = #{json};
        const nodeMap = Object.fromEntries(data.nodes.map(n => [n.id, n]));
        const edges = data.edges;
        const adj = {};
        for (let e of edges) {
          (adj[e.from] ||= []).push(e.to);
          (adj[e.to] ||= []).push(e.from);
        }
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        const dropdown = document.getElementById('dropdown');
        const info = document.getElementById('info');
        let width, height, activeNodes = [], activeEdges = [], hover = null, selected = null;

        function resize() { width = canvas.width = canvas.offsetWidth; height = canvas.height = canvas.offsetHeight; }
        window.addEventListener('resize', resize); resize();

        function neighbors(id, depth) {
          let seen = new Set([id]);
          let frontier = [id];
          for (let i = 0; i < depth; i++) {
            let next = [];
            for (let x of frontier) {
              for (let y of (adj[x] || [])) {
                if (!seen.has(y)) { seen.add(y); next.push(y); }
              }
            }
            frontier = next;
          }
          return Array.from(seen);
        }

        function focusOn(id) {
          let ids = neighbors(id, 2);
          let sub = Object.fromEntries(ids.map(i => [i, nodeMap[i]]));
          activeNodes = ids.map(i => ({...sub[i], x: width/2 + (Math.random()-0.5)*200, y: height/2 + (Math.random()-0.5)*200, vx:0, vy:0}));
          let a = Object.fromEntries(activeNodes.map(n => [n.id, n]));
          activeEdges = edges.filter(e => a[e.from] && a[e.to]).map(e => ({from: a[e.from], to: a[e.to]}));
          selected = a[id];
          info.textContent = `${activeNodes.length} notes within 2 hops of "${id}"`;
        }

        function radius(n) { return 4 + Math.sqrt(n.degree || 1) * 3; }

        function layout() {
          for (let n of activeNodes) { n.vx *= 0.85; n.vy *= 0.85; }
          for (let i = 0; i < activeNodes.length; i++) {
            for (let j = i + 1; j < activeNodes.length; j++) {
              let a = activeNodes[i], b = activeNodes[j];
              let dx = a.x - b.x, dy = a.y - b.y;
              let d = Math.sqrt(dx*dx + dy*dy) || 1;
              let f = 3000 / (d * d);
              a.vx += f * dx / d; a.vy += f * dy / d;
              b.vx -= f * dx / d; b.vy -= f * dy / d;
            }
          }
          for (let e of activeEdges) {
            let a = e.from, b = e.to;
            let dx = b.x - a.x, dy = b.y - a.y;
            let d = Math.sqrt(dx*dx + dy*dy) || 1;
            let f = 0.02 * (d - 90);
            a.vx += f * dx / d; a.vy += f * dy / d;
            b.vx -= f * dx / d; b.vy -= f * dy / d;
          }
          for (let n of activeNodes) {
            n.vx -= 0.01 * (n.x - width/2);
            n.vy -= 0.01 * (n.y - height/2);
            n.x += n.vx; n.y += n.vy;
          }
        }

        function draw() {
          ctx.fillStyle = '#111'; ctx.fillRect(0, 0, width, height);
          ctx.strokeStyle = 'rgba(139, 233, 253, 0.25)';
          for (let e of activeEdges) {
            ctx.beginPath(); ctx.moveTo(e.from.x, e.from.y); ctx.lineTo(e.to.x, e.to.y); ctx.stroke();
          }
          for (let n of activeNodes) {
            let r = radius(n);
            ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI*2);
            ctx.fillStyle = n === selected ? '#ff79c6' : n === hover ? '#50fa7b' : '#bd93f9';
            ctx.fill();
            if (n.degree >= 4 || n === hover || n === selected) {
              ctx.fillStyle = '#eee'; ctx.font = '12px sans-serif';
              ctx.fillText(n.id, n.x + r + 2, n.y + 4);
            }
          }
        }

        function loop() { layout(); draw(); requestAnimationFrame(loop); }
        loop();

        function nearest(x, y) {
          let best = null, bestD = Infinity;
          for (let n of activeNodes) {
            let d = Math.hypot(n.x - x, n.y - y);
            if (d < radius(n) + 3 && d < bestD) { bestD = d; best = n; }
          }
          return best;
        }

        canvas.addEventListener('mousemove', e => {
          let r = canvas.getBoundingClientRect();
          hover = nearest(e.clientX - r.left, e.clientY - r.top);
          canvas.style.cursor = hover ? 'pointer' : 'grab';
        });

        canvas.addEventListener('click', e => {
          let r = canvas.getBoundingClientRect();
          let n = nearest(e.clientX - r.left, e.clientY - r.top);
          if (n) { dropdown.value = n.id; focusOn(n.id); }
        });

        dropdown.addEventListener('change', () => { if (dropdown.value) focusOn(dropdown.value); });

        for (let n of data.nodes) {
          let opt = document.createElement('option');
          opt.value = n.id;
          opt.textContent = `${n.id} (${n.degree})`;
          dropdown.appendChild(opt);
        }

        if (data.nodes.length > 0) focusOn(data.nodes[0].id);
      </script>
    </body>
    </html>
    """
  end
end

VaultGraph.run(System.argv())
