// Records `heai-pod status --json` and `heai-pod list --json` through pod's CLI against
// its fake runtime and a queue the test helpers fill: five jobs, one queued, one running,
// three done (ok, failed, canceled), with the worker played by hand and the host path
// rewritten to /repo. Run from tools/pod (node resolves pod's helpers from there); the
// first argument is the directory to write into.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, listWith, makeWorld } from '../../../pod/test/helpers.ts'

const out = process.argv[2]
if (!out) throw new Error('usage: node pod.ts <out-dir>')

const w = makeWorld()
const must = (r: { code: number; stdout: string; stderr: string }, want: number, name: string) => {
  if (r.code !== want) throw new Error(`${name}: exit ${r.code}\n${r.stderr}`)
  return r.stdout.replaceAll(w.dir, '/repo')
}
const job = (actor: string, task: string) => {
  const name = `${actor}-${task}`
  must(cli(w, 'submit', w.jobDir(name, { 'job.json': '{"run": "cd repos/app && claude -p < ../../prompt.md"}\n', 'workdir/prompt.md': `${task}\n`, 'workdir/repos/app/README.md': 'hi\n' }), '--timeout', '2h'), 0, `submit ${name}`)
  return name
}
const ok = job('api-owner', 'cache-the-index')
const failed = job('core-reviewer', 'merge-two-entities')
const canceled = job('ops', 'rotate-keys')
const running = job('desktop-owner', 'add-place-entity')
job('web-ui', 'document-tabs')
w.claim(ok)
w.finish(ok, {}, { stdout: 'cached the index\n' })
w.claim(failed)
w.finish(failed, { status: 'failed', exit: 3 }, { stderr: 'tests failed\n' })
w.claim(canceled)
w.finish(canceled, { status: 'canceled', exit: -1, signal: 'TERMINATED', duration_ms: 4200, finished: '2026-09-25T10:00:04.200Z' })
w.claim(running)

w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'running') }])
writeFileSync(join(out, 'list.json'), must(cli(w, 'list', '--json'), 0, 'list'))
writeFileSync(join(out, 'status.json'), must(cli(w, 'status', '--json'), 0, 'status'))
w.replies([{ when: ['list', '--all'], stdout: listWith('heai-workshop', 'stopped') }])
writeFileSync(join(out, 'status-stopped.json'), must(cli(w, 'status', '--json'), 1, 'status, stopped'))
