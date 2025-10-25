#!/usr/bin/env bash
#
# install_prereqs.sh
# Installs prerequisites for the audio → whisper → ollama → mermaid pipeline
# Tested on macOS (Apple Silicon)

set -euo pipefail

echo "🔧 Installing prerequisites for causal-loop pipeline..."

# --- check Homebrew ---
if ! command -v brew &>/dev/null; then
  echo "🍺 Homebrew not found. Installing..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
else
  echo "✅ Homebrew already installed."
fi

# --- install packages ---
echo "📦 Installing ffmpeg, jq, whisper-cpp..."
brew install ffmpeg jq whisper-cpp || true

# --- install Ollama ---
if ! command -v ollama &>/dev/null; then
  echo "🧠 Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "✅ Ollama already installed."
fi

# --- pull model ---
echo "📥 Ensuring gpt-oss:20b model is pulled..."
ollama pull gpt-oss:20b || true

# --- download Whisper model via Hugging Face CDN ---
MODEL_DIR="$HOME/models"
MODEL_FILE="$MODEL_DIR/ggml-base.en.bin"
mkdir -p "$MODEL_DIR"

if [ ! -f "$MODEL_FILE" ]; then
  echo "🎧 Downloading Whisper base.en model from Hugging Face..."
  curl -L -o "$MODEL_FILE" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true"
else
  echo "✅ Whisper model already present: $MODEL_FILE"
fi

# --- summary ---
echo ""
echo "✅ All prerequisites installed."
echo "➡️  ffmpeg:       $(command -v ffmpeg)"
echo "➡️  whisper-cli:  $(command -v whisper-cli)"
echo "➡️  ollama:       $(command -v ollama)"
echo "➡️  jq:           $(command -v jq)"
echo "➡️  Whisper model: $MODEL_FILE"
echo ""
echo "You can now run:"
echo "  node audio_to_mermaid.js /path/to/audio.m4a --whisper-model \"$MODEL_FILE\" --model gpt-oss:20b --out diagram.mmd"
echo ""
