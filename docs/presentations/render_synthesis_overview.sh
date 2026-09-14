#!/usr/bin/env bash
set -Eeuo pipefail

readonly image="docker.io/marpteam/marp-cli:v4.5.0"
readonly presentation_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly output_pdf="$presentation_dir/synthesis_overview.pdf"
readonly container_name="synthesis-marp-$$"
readonly render_dir="$(mktemp -d /tmp/synthesis-marp.XXXXXXXX)"
readonly rendered_pdf="$render_dir/synthesis_overview.pdf"
readonly staged_pdf="$presentation_dir/.synthesis_overview.pdf.tmp.$$"

image_id=""
render_succeeded=0

cleanup_files() {
  rm -f -- "$staged_pdf"

  case "$render_dir" in
    /tmp/synthesis-marp.*)
      rm -rf -- "$render_dir"
      ;;
    *)
      printf 'Refusing to remove unexpected render directory: %s\n' \
        "$render_dir" >&2
      return 1
      ;;
  esac
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM

  podman rm --force "$container_name" >/dev/null 2>&1 || true
  if [[ "$render_succeeded" -eq 1 && -n "$image_id" ]]; then
    podman image rm --force "$image_id" >/dev/null 2>&1 || true
  fi
  cleanup_files || true

  exit "$status"
}
trap cleanup_on_exit EXIT INT TERM

for attempt in {1..6}; do
  podman pull "$image" && break
  ((attempt < 6)) || exit 1
  printf 'Marp image pull failed; retrying in 10 seconds (%d/6)...\n' \
    "$attempt" >&2
  sleep 10
done

image_id="$(podman image inspect --format '{{.Id}}' "$image")"

podman run --rm --init \
  --name "$container_name" \
  --pull=never \
  --userns=keep-id \
  --env "LANG=${LANG:-C.UTF-8}" \
  --env "MARP_USER=$(id -u):$(id -g)" \
  --volume "$presentation_dir:/home/marp/app:rw" \
  --volume "$render_dir:/home/marp/output:rw" \
  "$image_id" \
  synthesis_overview.md \
  --html \
  --pdf \
  --allow-local-files \
  --output /home/marp/output/synthesis_overview.pdf

if [[ ! -s "$rendered_pdf" ]]; then
  printf 'Marp completed without producing a non-empty PDF.\n' >&2
  exit 1
fi
render_succeeded=1

# Remove the named container before forcing removal of the exact pulled image.
# The force is intentional: it also clears stale Marp containers that would
# otherwise keep the image in use after a previous interrupted render.
podman rm --force "$container_name" >/dev/null 2>&1 || true
podman image rm --force "$image_id" >/dev/null

if podman container exists "$container_name"; then
  printf 'Marp container cleanup failed: %s is still present.\n' \
    "$container_name" >&2
  exit 1
fi

if podman image exists "$image_id"; then
  printf 'Marp image cleanup failed: %s is still present.\n' "$image_id" >&2
  exit 1
fi

cp -- "$rendered_pdf" "$staged_pdf"
chmod 0644 "$staged_pdf"
mv -- "$staged_pdf" "$output_pdf"
cleanup_files
trap - EXIT INT TERM

printf 'Rendered %s and removed Marp container, image, and temporary files.\n' \
  "$output_pdf"
