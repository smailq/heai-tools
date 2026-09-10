// A fake container runtime CLI: `container` and `docker` on PATH are one-line
// shell scripts that exec this with their own name first. It records every
// argv to $FAKE_RUNTIME_DIR/calls.jsonl and answers from
// $FAKE_RUNTIME_DIR/replies.json, a list of
//   { "when": [...argv fragment, "*" matches one element], "stdout"?, "stdoutFile"?, "stderr"?, "code"?, "once"? }
// where the first reply whose `when` occurs contiguously in argv wins. With no
// match, `list` and `ps` answer with the recorded fixture and anything else
// succeeds silently.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = process.env['FAKE_RUNTIME_DIR']
if (!dir) {
  process.stderr.write('FAKE_RUNTIME_DIR is not set\n')
  process.exit(2)
}
const [bin, ...argv] = process.argv.slice(2)
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ bin, argv }) + '\n')

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')
const repliesPath = join(dir, 'replies.json')
const replies = existsSync(repliesPath) ? JSON.parse(readFileSync(repliesPath, 'utf8')) : []

const occurs = (when) => {
  for (let i = 0; i + when.length <= argv.length; i++) {
    if (when.every((w, j) => w === '*' || w === argv[i + j])) return true
  }
  return false
}

const idx = replies.findIndex((r) => occurs(r.when))
if (idx >= 0) {
  const r = replies[idx]
  if (r.once) {
    replies.splice(idx, 1)
    writeFileSync(repliesPath, JSON.stringify(replies))
  }
  const stdout = r.stdoutFile ? readFileSync(join(fixtures, r.stdoutFile), 'utf8') : (r.stdout ?? '')
  process.stdout.write(stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  process.exit(r.code ?? 0)
}
if (argv[0] === 'list' && bin === 'container') {
  process.stdout.write(readFileSync(join(fixtures, 'container-list.json'), 'utf8'))
} else if (argv[0] === 'ps') {
  process.stdout.write(readFileSync(join(fixtures, 'docker-ps.jsonl'), 'utf8'))
}
process.exit(0)
