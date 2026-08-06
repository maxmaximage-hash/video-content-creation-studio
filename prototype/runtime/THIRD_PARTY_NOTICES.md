# Transcription runtime notices

The packaged transcription runtime is built only from the checksum-locked artifacts in `runtime-lock.json`.

- imageio-ffmpeg 0.6.0 / FFmpeg 7.1: BSD-2-Clause for the Python package; the bundled FFmpeg executable reports GPL-2.0-or-later because it is built with GPL components. Source: https://github.com/imageio/imageio-ffmpeg and https://ffmpeg.org/.
- whisper.cpp 1.8.6: MIT. Source: https://github.com/ggml-org/whisper.cpp/tree/v1.8.6.
- ggml-small Whisper model: MIT, inherited from the upstream OpenAI Whisper weights and conversion project. Source: https://huggingface.co/ggerganov/whisper.cpp.

The platform collection algorithms adapted from `zzzzzc946-hub/chen-content-collector` retain its MIT attribution: Copyright (c) 2026 CHEN.
