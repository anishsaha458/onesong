#!/usr/bin/env bash
# Exit on error
set -o errexit

# Install ffmpeg (Required for yt-dlp audio extraction)
apt-get update && apt-get install -y ffmpeg

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt