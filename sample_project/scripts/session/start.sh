#!/bin/sh
# The hook on `queued` and `resumable`. In a real project this opens a pod
# workspace and prompts the agent; the sample only records that it ran.
echo "start.sh: would open a workspace for $HEAI_LINK_ACTOR on $HEAI_LINK_TASK (flow $HEAI_FLOW)"
