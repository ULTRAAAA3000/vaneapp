#!/usr/bin/env bash
# Makes the landing hero video: the clip forward, then the same clip reversed, as ONE file that loops with no cut.
# (Browsers cannot play video backwards, and reversing live by seeking looks choppy; a pre-reversed file is perfectly smooth.)
#
#   scripts/make-hero-boomerang.sh input.mp4 [output.mp4] [crf]      needs ffmpeg (Windows: winget install ffmpeg)
#
# The reversed part leaves out both turning frames (the last and the first of the clip), so no frame is shown twice at either joint:
# N frames in, 2N-2 frames out. Output is H.264, no audio, faststart, a keyframe every 48 frames.
# Size: roughly 1.3x the source at crf 20. Cloudflare Pages takes a file up to 25 MiB; if the result is bigger, raise the crf (23, 26)
# or add a scale to the filter, e.g. [0:v]scale=1280:-2,split[f][r].
# The file in use is public/assets/hero-boomerang-v1.mp4; give a new version a new name (-v2) so browsers do not keep the old one.
set -euo pipefail

in="${1:?usage: $0 input.mp4 [output.mp4] [crf]}"
out="${2:-hero-boomerang.mp4}"
crf="${3:-20}"

n=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "$in")

ffmpeg -y -i "$in" \
  -filter_complex "[0:v]split[f][r];[r]reverse,trim=start_frame=1:end_frame=$((n-1)),setpts=PTS-STARTPTS[rv];[f][rv]concat=n=2:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -an -c:v libx264 -preset slow -crf "$crf" -g 48 -movflags +faststart -fps_mode cfr "$out"

echo "Done: $out ($(du -h "$out" | cut -f1)): $n frames in, $((2*n-2)) frames out."
