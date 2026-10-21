#!/usr/bin/env bash
# Makes a "boomerang" of a video: forward, then the same thing in reverse, as ONE file that loops with no cut.
# Optional: the hero already ping-pongs in the browser (public/assets/hero-loop.js). Use this file instead only if the
# in-browser reverse ever looks choppy on some device: upload the result, point the hero <video> at it, drop data-pingpong.
#
#   scripts/make-hero-boomerang.sh input.mp4 [output.mp4]      needs ffmpeg
#
# The reverse part skips its first frame (it is the last frame of the forward part), so there is no stutter at the turn.
set -euo pipefail

in="${1:?usage: $0 input.mp4 [output.mp4]}"
out="${2:-hero-boomerang.mp4}"

ffmpeg -y -i "$in" \
  -filter_complex "[0:v]split[f][r];[r]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[rv];[f][rv]concat=n=2:v=1:a=0,format=yuv420p[v]" \
  -map "[v]" -an -c:v libx264 -preset slow -crf 23 -g 48 -movflags +faststart "$out"

echo "Done: $out ($(du -h "$out" | cut -f1)). Upload it and use it as the hero video's src with the plain loop."
