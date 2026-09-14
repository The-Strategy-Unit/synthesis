# Security policy

## Supported releases

Security fixes are prepared for the latest tagged Synthesis private-beta
release. Older builds and untagged snapshots are unsupported. Synthesis has no
automatic updater: operators must verify and install replacement releases.

## Report a vulnerability

Do not open a public issue for a suspected vulnerability or exposed secret. Use
the repository's
[private vulnerability report](https://github.com/The-Strategy-Unit/synthesis/security/advisories/new)
and include the affected version, operating system, impact, and minimal
reproduction. Do not include real vault contents, API keys, or tester data.

The maintainers aim to acknowledge critical reports within two business days.
Timelines for a fix and coordinated disclosure depend on severity and the
affected dependency or platform.

## Security boundary

Synthesis is a single-user, local-first research application. Keep its loopback
listener, vault, backups, and operating-system account private. A remote AI
provider receives the source and wiki context required for explicit requests;
there is no silent remote fallback.

Do not use Synthesis for identifiable patient data, clinical decisions, or
regulated production work without a separate governance, validation, access,
retention, and recovery assessment.

Tagged release executables are currently unsigned, and macOS builds are not
notarized. Operators and testers must verify the release archive's SHA-256
checksum and GitHub build-provenance attestation and explicitly accept any
operating-system warning. Add signing or notarization only after the required
accounts, certificates, and CI secrets are provisioned and tested.
