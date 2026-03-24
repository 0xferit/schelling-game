#!/bin/bash
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only typecheck TypeScript files
if [[ ! "$FILE_PATH" =~ \.ts$ ]]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

ERRORS=""

# Node-side typecheck
NODE_OUT=$(npx tsc --noEmit 2>&1)
if [ $? -ne 0 ]; then
  ERRORS="$ERRORS\n--- Node typecheck errors ---\n$NODE_OUT"
fi

# Worker-side typecheck
WORKER_OUT=$(npx tsc --noEmit -p tsconfig.worker.json 2>&1)
if [ $? -ne 0 ]; then
  ERRORS="$ERRORS\n--- Worker typecheck errors ---\n$WORKER_OUT"
fi

if [ -n "$ERRORS" ]; then
  echo -e "$ERRORS" >&2
fi

exit 0
