/* Harness — article enhancements. Progressive only: the page reads fine without JS.
   1) highlight the section currently in view in the table of contents;
   2) add a copy button to code blocks when the Clipboard API is available. */
(function () {
  'use strict';

  /* 1. Table of contents: mark the last heading that has scrolled past the header */
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  var pairs = [];
  links.forEach(function (a) {
    var id = decodeURIComponent(a.getAttribute('href').slice(1));
    var el = document.getElementById(id);
    if (el) pairs.push({ heading: el, links: links.filter(function (l) { return l.getAttribute('href') === a.getAttribute('href'); }) });
  });
  if (pairs.length) {
    var current = null;
    var offset = 110; /* sticky header (64px) plus breathing room */
    var update = function () {
      var pick = pairs[0];
      for (var i = 0; i < pairs.length; i++) {
        if (pairs[i].heading.getBoundingClientRect().top - offset <= 0) pick = pairs[i];
        else break;
      }
      if (pick === current) return;
      current = pick;
      links.forEach(function (l) { l.classList.remove('is-active'); l.removeAttribute('aria-current'); });
      pick.links.forEach(function (l) { l.classList.add('is-active'); l.setAttribute('aria-current', 'true'); });
    };
    var ticking = false;
    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () { update(); ticking = false; });
    }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  /* 2. Copy buttons for code blocks */
  if (navigator.clipboard && window.isSecureContext) {
    document.querySelectorAll('.code-block').forEach(function (block) {
      var head = block.querySelector('.code-head');
      var pre = block.querySelector('pre');
      if (!head || !pre) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.textContent = '复制';
      btn.setAttribute('aria-label', '复制代码');
      btn.addEventListener('click', function () {
        navigator.clipboard.writeText(pre.innerText).then(function () {
          btn.textContent = '已复制';
          window.setTimeout(function () { btn.textContent = '复制'; }, 1600);
        }, function () {
          btn.textContent = '复制失败';
          window.setTimeout(function () { btn.textContent = '复制'; }, 1600);
        });
      });
      head.appendChild(btn);
    });
  }
})();
