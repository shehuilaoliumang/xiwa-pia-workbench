'use strict';
(() => {
  const page = document.body.dataset.page;
  if (!['catalog', 'reader'].includes(page)) return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const workspace = document.getElementById('main');
  let leaving = false;
  const key = 'pia-page-transition';

  function reset() {
    leaving = false;
    workspace.classList.remove('page-leaving', 'page-entering');
  }

  function enter() {
    reset();
    let destination;
    try { destination = sessionStorage.getItem(key); sessionStorage.removeItem(key); } catch (_) {}
    const backwards = performance.getEntriesByType('navigation')[0]?.type === 'back_forward';
    if (!reduced.matches && (destination === location.pathname || backwards)) {
      workspace.classList.add('page-entering');
      workspace.addEventListener('animationend', () => workspace.classList.remove('page-entering'), {once: true});
    }
  }

  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href, location.href);
    const isReader = /^\/script\/[^/]+$/.test(url.pathname);
    const change = (page === 'catalog' && isReader) || (page === 'reader' && url.pathname === '/');
    if (!change || url.origin !== location.origin || reduced.matches) return;
    event.preventDefault();
    if (leaving) return;
    leaving = true;
    try { sessionStorage.setItem(key, url.pathname); } catch (_) {}
    workspace.classList.remove('page-entering');
    workspace.classList.add('page-leaving');
    setTimeout(() => location.assign(url.href), 140);
    // A cancelled navigation must never leave a blank page behind.
    setTimeout(reset, 1600);
  });

  window.addEventListener('pageshow', enter);
  window.addEventListener('pagehide', reset);
  reduced.addEventListener('change', () => { if (reduced.matches) reset(); });
})();
