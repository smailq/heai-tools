// Two behaviours the server cannot provide on its own, and nothing else.
//
// Everything here is an enhancement: the page is fully usable with this file
// blocked or failing. Links navigate, forms post and redirect, and the only
// thing lost is the scroll position of a long list.
//
//   1. Navigation without a reload, so moving between tasks keeps the list
//      where it was. In a list of a hundred, a full reload jumping back to the
//      top is the difference between triaging and hunting.
//   2. Arming the delete button, so deleting takes two deliberate clicks.
//      Without this file the server asks for confirmation on its own page
//      instead, which is why delete is safe either way.
;(function () {
  var app = function () {
    return document.querySelector('.app')
  }

  /** Fetch a page and swap the app in, keeping the list's scroll position. */
  function navigate(url, push) {
    fetch(url, { headers: { 'x-partial': '1' } })
      .then(function (res) {
        if (!res.ok) throw new Error('not ok')
        return res.text()
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html')
        var next = doc.querySelector('.app')
        var current = app()
        if (!next || !current) throw new Error('no app')

        var list = current.querySelector('aside')
        var top = list ? list.scrollTop : 0
        current.innerHTML = next.innerHTML

        var newList = current.querySelector('aside')
        if (newList) newList.scrollTop = top
        var detail = current.querySelector('.detail')
        if (detail) detail.scrollTop = 0

        document.title = doc.title
        if (push) history.pushState(null, '', url)
      })
      .catch(function () {
        location.href = url
      })
  }

  document.addEventListener('click', function (e) {
    // Anything the browser would treat specially stays the browser's.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    var link = e.target.closest && e.target.closest('a')
    if (!link || link.host !== location.host || !link.closest('.app')) return
    if (link.target || link.hasAttribute('download')) return
    e.preventDefault()
    navigate(link.href, true)
  })

  window.addEventListener('popstate', function () {
    navigate(location.href, false)
  })

  document.addEventListener('submit', function (e) {
    var form = e.target
    if (!form.closest || !form.closest('.app')) return
    e.preventDefault()

    // Delete asks twice. The first click arms the button and says so.
    if (form.classList.contains('del') && !form.dataset.armed) {
      form.dataset.armed = '1'
      var button = form.querySelector('.dbtn')
      button.textContent = 'click again to delete'
      button.classList.add('armed')
      return
    }

    var body = new URLSearchParams(new FormData(form, e.submitter))
    fetch(form.action, { method: 'POST', body: body, redirect: 'follow' })
      .then(function (res) {
        var target = res.ok ? res.url : location.href
        history.replaceState(null, '', target)
        navigate(target, false)
      })
      .catch(function () {
        location.reload()
      })
  })
})()
