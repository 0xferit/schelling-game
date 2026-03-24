#!/bin/bash
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only check git commit commands
if [[ ! "$COMMAND" =~ ^git\ commit ]]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Run both typechecks
NODE_OUT=$(npx tsc --noEmit 2>&1)
NODE_RC=$?

WORKER_OUT=$(npx tsc --noEmit -p tsconfig.worker.json 2>&1)
WORKER_RC=$?

if [ $NODE_RC -ne 0 ] || [ $WORKER_RC -ne 0 ]; then
  echo "Blocked: TypeScript errors must be fixed before committing." >&2
  [ $NODE_RC -ne 0 ] && echo -e "--- Node typecheck ---\n$NODE_OUT" >&2
  [ $WORKER_RC -ne 0 ] && echo -e "--- Worker typecheck ---\n$WORKER_OUT" >&2
  exit 2
fi

exit 0
