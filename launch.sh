#!/bin/bash
# launch.sh — (re)starts the Lead Machine dashboard with the latest code and opens it.
# Used by the "Lead Machine" desktop app. Safe to double-click directly too.

PROJECT="/Users/kylecantrell/Desktop/lead-machine"
NODE="/usr/local/bin/node"
PORT=4000
URL="http://localhost:$PORT"

cd "$PROJECT" || exit 1

# Kill any server already running on this port so we always start with the
# newest code. Ignore errors if nothing is listening.
EXISTING_PID="$(lsof -ti tcp:"$PORT" 2>/dev/null)"
if [ -n "$EXISTING_PID" ]; then
  kill $EXISTING_PID 2>/dev/null
  # Give it a moment to release the port before we restart.
  for i in $(seq 1 20); do
    curl -s -o /dev/null "$URL" || break
    sleep 0.25
  done
fi

# Start the server detached so it keeps running after this script exits.
PORT=$PORT nohup "$NODE" dashboard/server.js > /tmp/lead-machine.log 2>&1 &

# Wait (up to ~20s) for it to come up, then open the browser.
for i in $(seq 1 40); do
  if curl -s -o /dev/null "$URL"; then
    open "$URL"
    exit 0
  fi
  sleep 0.5
done

# Fallback: open anyway + show the log if it never came up.
open "$URL"
open /tmp/lead-machine.log
