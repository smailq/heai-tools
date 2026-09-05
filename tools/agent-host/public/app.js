// Two behaviours the server cannot provide on its own, and nothing else.
//
//   1. The live log: a running run's log streams in through
//      /api/runs/<id>/log?follow=1 instead of needing a reload.
//   2. The actor list refreshing from /api/events, so a run that finishes
//      while the page is open shows as finished.
//
// The page is fully usable with this file blocked: forms post and redirect,
// and a reload shows the current state.
;(function () {
  var app = document.querySelector('.app')
  if (!app) return
  var base = app.getAttribute('data-base') || ''

  // Stop with a running run asks twice.
  document.addEventListener('submit', function (e) {
    var button = e.submitter
    if (button && button.hasAttribute('data-confirm') && !button.dataset.armed) {
      e.preventDefault()
      button.dataset.armed = '1'
      button.textContent = 'click again to stop'
      button.classList.add('armed')
    }
  })

  var live = document.querySelector('pre.log[data-live]')
  if (live && window.fetch && window.TextDecoder) {
    var id = live.getAttribute('data-run')
    fetch(base + '/api/runs/' + encodeURIComponent(id) + '/log?follow=1')
      .then(function (res) {
        if (!res.ok || !res.body) return
        live.textContent = ''
        var reader = res.body.getReader()
        var decoder = new TextDecoder()
        var read = function () {
          return reader.read().then(function (r) {
            if (r.done) {
              location.reload()
              return
            }
            live.textContent += decoder.decode(r.value, { stream: true })
            live.scrollTop = live.scrollHeight
            return read()
          })
        }
        return read()
      })
      .catch(function () {})
  }

  if (window.EventSource && !live) {
    var source = new EventSource(base + '/api/events')
    var pending = null
    var refresh = function () {
      if (pending) return
      pending = setTimeout(function () {
        pending = null
        fetch(location.href)
          .then(function (res) {
            return res.text()
          })
          .then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html')
            var next = doc.querySelector('.app')
            if (!next) return
            var aside = app.querySelector('aside')
            var top = aside ? aside.scrollTop : 0
            app.innerHTML = next.innerHTML
            var again = app.querySelector('aside')
            if (again) again.scrollTop = top
          })
          .catch(function () {})
      }, 300)
    }
    source.addEventListener('actor', refresh)
    source.addEventListener('run', refresh)
  }
})()
