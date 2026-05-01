# Synthesis

A CLI + web tool that extracts atomic insights from podcast transcripts and generates
Obsidian-ready Zettelkasten markdown notes — for individuals and teams.

## How it works

```
YouTube URL → yt-dlp → transcript → LLM → markdown notes → Obsidian vault
```

Each podcast produces:
- A **summary note** with YAML frontmatter
- Multiple **atomic insight notes** with `[[wikilinks]]` to related concepts

## Output format

Notes follow the Zettelkasten convention:
- One idea per note
- YAML frontmatter: `id`, `source`, `date`, `tags`, `related`
- Bidirectional links via Obsidian `[[wikilinks]]`

## Deployment

| Mode | Target |
|------|--------|
| Single user | Burrito binary (no BEAM required) |

## Roadmap

- [x] Single-user local mode (Ollama + Burrito)
- [ ] Minimal single-page Phoenix LiveView web interface
- [ ] Swappable LLM backend (Azure OpenAI)
- [ ] Submission queue + curator approval (multi-user)
- [ ] Role-based access control
- [ ] Azure hosted deployment

## License

MIT
