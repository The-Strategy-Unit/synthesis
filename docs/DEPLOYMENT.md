# Private-beta operations

Synthesis is supported as a local desktop private beta: one named user, one
stateful process, and one writable vault. This runbook does not make the app a
multi-user, clinical, regulated, serverless, or production service.

## Release gate

Before inviting testers:

1. Run format, lint, type, unit, integration, E2E, browser, native compile, and
   compiled lifecycle smoke checks on Linux x64, macOS ARM64, and Windows x64.
2. Confirm testers understand that executables are unsigned and macOS builds are
   not notarized, including the operating-system warnings they may see.
3. Download each published archive, verify `SHA256SUMS` and its repository
   attestation, and launch it on the target operating system.
4. Exercise vault selection, a redacted synthetic vault, source review, offline
   approval, source evidence, **Verify vault**, export, restore, rebuild, and
   newest-ingest undo.
5. Record the tested tag, commit, platforms, known limitations, and named beta
   cohort. Keep the cohort small enough for direct support.

## Tester setup

- Use a dedicated non-administrator operating-system account with current OS
  security updates and full-disk encryption.
- Keep the application bound to loopback. Do not expose port 8000 through a
  firewall, tunnel, shared host, or reverse proxy for the desktop beta.
- Store the vault on a local persistent disk. Avoid live synchronization tools
  that can rewrite files while Synthesis is running.
- Prefer the local provider. If a remote provider is explicitly selected,
  document its terms, region, retention, and approved data classification.
- Do not ingest secrets, patient records, or other regulated identifiable data.

## Backup and recovery

Export the vault after material review sessions and copy the archive to an
encrypted, access-controlled backup location. Periodically test the complete
restore path into an empty directory: open the restored vault, run **Verify
vault**, rebuild the catalogue, and inspect representative evidence and history.
Semantic state is rebuildable and is deliberately absent from export.

Synthesis holds an operating-system-backed process lock for the writable vault.
Accepted ingests use a durable journal. After an unexpected shutdown, startup
finishes the exact approved file set and rebuilds derived state before serving
requests. A conflicting external edit fails recovery instead of being
overwritten.

## Updates and rollback

There is no automatic updater. Announce a tested tag and checksum to the beta
cohort, stop Synthesis, take a vault export, replace only the executable, and
restart the same vault. Never downgrade a vault after a format migration unless
the release notes provide a tested path. Roll back an executable only when its
release explicitly supports the current vault format.

## Support and incidents

Collect the Synthesis version, operating system, operation, safe error text, and
request ID. Never request a user's vault, source document, credential, or raw
provider response by default. Reproduce with a redacted synthetic vault.

For suspected compromise, stop the app, preserve the executable and logs,
disconnect any configured remote provider, and report privately using
`SECURITY.md`. Credential revocation and tester notification are operator
decisions; do not rotate or disclose credentials from application diagnostics.

## Future hybrid evaluation

A hosted or hybrid beta needs a separate persistence and runtime design. Decide
the local/cloud responsibility split first. Development may evaluate `floci.io`
for Azure-compatible emulation and an EU VPS such as Hetzner, subject to
security, governance, residency, support, and procurement review. Remote model
inference, including a European API such as Mistral, must remain explicit and
must never silently receive vault or source content.
