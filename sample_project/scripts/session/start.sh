#!/bin/sh
# The hook on `queued` and `resumable`. In a real project this prepares a job
# directory and submits it to pod; the sample only records that it ran.
echo "start.sh: would submit a job for $HEAI_LINK_ACTOR on $HEAI_LINK_TASK (flow $HEAI_FLOW)"
