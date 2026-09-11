#!/bin/sh
# The hook on `exited`. In a real project this brings the branch home and
# gates it; the sample only records that it ran.
echo "finish.sh: would gate $HEAI_LINK_BRANCH for $HEAI_LINK_ACTOR (flow $HEAI_FLOW)"
