#!/usr/bin/env bash
# Exit on error
set -o errexit

# Install System Dependencies for Audio Processing & Essentia
apt-get update && apt-get install -y \
    ffmpeg \
    libfftw3-dev \
    libyaml-dev \
    libsamplerate0-dev \
    libtag1-dev \
    libchromaprint-dev

# Install Python dependencies
pip install --upgrade pip
pip install -r requirements.txt