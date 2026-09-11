#!/bin/sh
# The minute rule: fold facts, fire clocks and guards, then say what is open.
heai-flow settle && heai-flow list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).filter(f=>!f.terminal).length+" open flows"))'
