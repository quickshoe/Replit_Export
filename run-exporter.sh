#!/bin/bash

# Replit Agent Exporter
# Run this script to export chat history and checkpoints

echo "Starting Replit Agent Exporter..."

# Check for command line arguments
if [ "$1" == "--dry-run" ] || [ "$1" == "-d" ]; then
    npx tsx exporter/index.ts --dry-run
elif [ "$1" == "--clear-session" ]; then
    npx tsx exporter/index.ts --clear-session
elif [ "$1" == "--help" ] || [ "$1" == "-h" ]; then
    npx tsx exporter/index.ts --help
else
    npx tsx exporter/index.ts "$@"
fi
