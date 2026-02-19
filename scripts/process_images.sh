#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/process_images.sh --slug <slug> [--format webp|auto|jpeg] [--start-index N] <image1> [image2 ...]
  ./scripts/process_images.sh --slug <slug> [--format webp|auto|jpeg] [--start-index N]

Behavior:
  - If image files are not passed, script reads all images from ./incoming/.
  - Output structure:
      photos/<slug>/original/
      photos/<slug>/1920/
      photos/<slug>/1280/
      photos/<slug>/640/
  - Naming:
      <slug>-001-original.<ext>
      <slug>-001-1920.<ext>
      <slug>-001-1280.<ext>
      <slug>-001-640.<ext>
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

slug=""
format="auto"
format="webp"
start_index=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)
      slug="${2:-}"
      shift 2
      ;;
    --format)
      format="${2:-}"
      shift 2
      ;;
    --start-index)
      start_index="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [[ -z "$slug" ]]; then
  echo "--slug is required." >&2
  usage
  exit 1
fi

if ! [[ "$start_index" =~ ^[0-9]+$ ]] || [[ "$start_index" -lt 1 ]]; then
  echo "--start-index must be a positive integer." >&2
  exit 1
fi

case "$format" in
  webp|auto|jpeg) ;;
  *)
    echo "--format must be one of: webp, auto, jpeg" >&2
    exit 1
    ;;
esac

declare -a inputs=()
if [[ $# -gt 0 ]]; then
  inputs=("$@")
else
  incoming_dir="$REPO_ROOT/incoming"
  if [[ ! -d "$incoming_dir" ]]; then
    echo "No input files passed and incoming/ folder does not exist: $incoming_dir" >&2
    exit 1
  fi

  while IFS= read -r -d '' file; do
    inputs+=("$file")
  done < <(find "$incoming_dir" -maxdepth 1 -type f \
    \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' -o -iname '*.heic' -o -iname '*.avif' \) \
    -print0 | sort -z)
fi

if [[ "${#inputs[@]}" -eq 0 ]]; then
  echo "No images found to process." >&2
  exit 1
fi

encoder=""
output_ext=""
if [[ "$format" == "webp" ]]; then
  if command -v magick >/dev/null 2>&1; then
    encoder="magick-webp"
    output_ext="webp"
  elif command -v cwebp >/dev/null 2>&1; then
    encoder="cwebp-webp"
    output_ext="webp"
  else
    echo "WebP requested, but no WebP encoder found ('magick' or 'cwebp')." >&2
    echo "Install ImageMagick or libwebp, or rerun with --format jpeg." >&2
    exit 1
  fi
elif [[ "$format" == "jpeg" ]]; then
  encoder="sips-jpeg"
  output_ext="jpg"
else
  if command -v magick >/dev/null 2>&1; then
    encoder="magick-webp"
    output_ext="webp"
  elif command -v cwebp >/dev/null 2>&1; then
    encoder="cwebp-webp"
    output_ext="webp"
  else
    encoder="sips-jpeg"
    output_ext="jpg"
  fi
fi

sizes=(1920 1280 640)

base_dir="$REPO_ROOT/photos/$slug"
mkdir -p "$base_dir/original"
for size in "${sizes[@]}"; do
  mkdir -p "$base_dir/$size"
done

index="$start_index"
echo "Processing ${#inputs[@]} image(s) with encoder: $encoder"

for src in "${inputs[@]}"; do
  if [[ ! -f "$src" ]]; then
    echo "Skipping missing file: $src" >&2
    continue
  fi

  filename="$(basename "$src")"
  src_ext="${filename##*.}"
  src_ext_lower="$(echo "$src_ext" | tr '[:upper:]' '[:lower:]')"
  id="$(printf "%03d" "$index")"

  original_out="$base_dir/original/${slug}-${id}-original.${src_ext_lower}"
  src_abs="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
  out_abs="$(cd "$(dirname "$original_out")" && pwd)/$(basename "$original_out")"
  if [[ "$src_abs" != "$out_abs" ]]; then
    cp "$src" "$original_out"
  fi

  for size in "${sizes[@]}"; do
    out_file="$base_dir/$size/${slug}-${id}-${size}.${output_ext}"
    if [[ "$encoder" == "magick-webp" ]]; then
      magick "$src" -auto-orient -strip -resize "${size}x${size}>" -quality 80 "$out_file"
    elif [[ "$encoder" == "cwebp-webp" ]]; then
      tmp_file="$(mktemp "${TMPDIR:-/tmp}/walkimg.XXXXXX.jpg")"
      sips -s format jpeg --resampleHeightWidthMax "$size" "$src" --out "$tmp_file" >/dev/null
      cwebp -quiet -q 80 "$tmp_file" -o "$out_file" >/dev/null
      rm -f "$tmp_file"
    else
      sips -s format jpeg --resampleHeightWidthMax "$size" "$src" --out "$out_file" >/dev/null
    fi
  done

  echo "Created set for #$id from: $filename"
  index=$((index + 1))
done

echo "Done. Outputs are under: $base_dir"
