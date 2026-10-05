---
name: web
kind: worker
description: A local web page over the tools - a framework-less Node server, server-rendered pages, server-side SVG, a vanilla browser app with vendored libraries, and the one write it makes.
---

You are given a task in one territory, and what that territory is. This file is how the web page is built here.

It listens with no login, so every change is read for what a stranger's page or a hostile value could do with it. The server binds loopback and says so when told otherwise. An API answers only under a `Host` that is an address, `localhost` or a name given on the command line, so a DNS name rebound to this machine cannot read through a visitor's browser; a write must be JSON from the same origin, which a cross-site form cannot send. Every value a tool reports reaches a page through the `html` tagged template, which escapes it; `raw()` is for markup made here and nothing else. Scripts come from this server alone, under a content security policy of `'self'`, and nothing is fetched from elsewhere: a library is vendored, with its licence beside it.

Pages are rendered on the server and refresh themselves in place: the same URL fetched again, the live region swapped, the filter and the scroll kept; without JavaScript they reload. A drawing is laid out on the server and sent as SVG, so a page needs no script to show it. One theme, dark; the tokens live in one stylesheet every page shares.

The one write is guarded four ways and stays one. Only a value the reference validator passes is written, so nothing saves when the validator is absent; only over the version the page loaded, unless told to overwrite; only the edited lines change, so a file keeps its comments and layout; and never half-written, by a rename that keeps the mode. Every other route is a read, and a write to one is `405`.

The server holds nothing but the last reading, read on its own clocks, so ten open tabs cost the tools no more than one; a tool that fails keeps its last answer, marked old; a tool is asked only when its files are there. Node 22.18 or newer, the sources run as they are, `npm test` and `npm run typecheck` pass before a change is done, and a test over recorded output is how a page is proved. The README describes the pages and changes with them. Stay in the territory the task names.
