#!/usr/bin/env bash
set -Eeuo pipefail

readonly marp_binary="$HOME/AppImages/marp"
readonly presentation_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly source_markdown="$presentation_dir/synthesis_overview.md"
readonly source_assets="$presentation_dir/assets"
readonly bundle_dir="$(mktemp -d /tmp/synthesis-presenter.XXXXXXXX)"
readonly bundle_html="$bundle_dir/index.html"
readonly bind_host="127.0.0.1"
readonly port="${SYNTHESIS_PRESENTATION_PORT:-8080}"

cleanup() {
  case "$bundle_dir" in
    /tmp/synthesis-presenter.*)
      rm -rf -- "$bundle_dir"
      ;;
    *)
      printf 'Refusing to remove unexpected presenter directory: %s\n' \
        "$bundle_dir" >&2
      ;;
  esac
}
trap cleanup EXIT

if [[ "${1:-}" == "--check" ]]; then
  readonly check_only=1
elif [[ $# -eq 0 ]]; then
  readonly check_only=0
else
  printf 'Usage: %s [--check]\n' "${0##*/}" >&2
  exit 2
fi

if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  printf 'SYNTHESIS_PRESENTATION_PORT must be between 1024 and 65535.\n' >&2
  exit 2
fi

if [[ ! -x "$marp_binary" ]]; then
  printf 'Marp executable not found: %s\n' "$marp_binary" >&2
  exit 1
fi

cp -- "$source_markdown" "$bundle_dir/index.md"
cp -a -- "$source_assets" "$bundle_dir/assets"

(
  cd -- "$bundle_dir"
  "$marp_binary" index.md \
    --html \
    --template bespoke \
    --output index.html
)

if [[ ! -s "$bundle_html" ]]; then
  printf 'Marp completed without producing a non-empty HTML presentation.\n' >&2
  exit 1
fi

mapfile -t image_references < <(
  rg -o 'src="assets/[^"]+"' "$bundle_html" |
    sed -e 's/^src="//' -e 's/"$//' |
    sort -u
)

if [[ ${#image_references[@]} -eq 0 ]]; then
  printf 'The generated presentation contains no local image references.\n' >&2
  exit 1
fi

for image_reference in "${image_references[@]}"; do
  if [[ "$image_reference" == *".."* ]] ||
    [[ ! -f "$bundle_dir/$image_reference" ]]; then
    printf 'Missing or unsafe presentation image: %s\n' \
      "$image_reference" >&2
    exit 1
  fi
done

if ! rg -q 'Timing:' "$bundle_html"; then
  printf 'The generated presenter HTML does not contain speaker notes.\n' >&2
  exit 1
fi

if [[ "$check_only" -eq 1 ]]; then
  printf 'Validated presenter HTML with %d local images.\n' \
    "${#image_references[@]}"
  exit 0
fi

printf 'Presenter bundle: %s\n' "$bundle_dir"
printf 'Open http://%s:%s/index.html and press P for presenter view.\n' \
  "$bind_host" "$port"
printf 'Press Ctrl-C here when finished; the temporary bundle will be removed.\n'

python3 -m http.server "$port" \
  --bind "$bind_host" \
  --directory "$bundle_dir"
