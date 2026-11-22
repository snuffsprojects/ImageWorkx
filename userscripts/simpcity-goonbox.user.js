// ==UserScript==
// @name         SimpCity GoonBox link copier
// @namespace    ImageWorkx
// @version      1.0.0
// @description  Copy the GoonBox links from one SimpCity post, one per line.
// @match        https://simpcity.cr/threads/*
// @match        https://www.simpcity.cr/threads/*
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(() => {
  'use strict';

  const postSelector = 'article.message--post, article[data-content^="post-"]';
  const contentSelector = '.message-body .bbWrapper, .message-body';
  const excluded = '.bbCodeBlock--quote, blockquote, .bbCodeBlock--unfurl, .message-signature';
  const buttonClass = 'imageworks-copy-goonbox';

  function postLinks(post) {
    const content = post.querySelector(contentSelector);
    if (!content) return [];
    const links = new Set();
    for (const element of content.querySelectorAll('a[href], img[src], img[data-src], img[data-url]')) {
      if (element.closest(excluded)) continue;
      for (const attr of ['href', 'data-src', 'data-url', 'src']) {
        const value = element.getAttribute(attr);
        if (!value || !URL.canParse(value, location.href)) continue;
        const url = new URL(value, location.href);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) continue;
        if (!/(^|\.)goonbox\.cr$/i.test(url.hostname) || url.pathname === '/') continue;
        url.hash = '';
        links.add(url.href);
      }
    }
    return [...links];
  }

  function addButtons() {
    for (const post of document.querySelectorAll(postSelector)) {
      if (!post.querySelector(contentSelector) || post.querySelector('.' + buttonClass)) continue;
      const actions = post.querySelector('.message-actionBar, .message-footer') || post.querySelector('.message-body');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button--link ' + buttonClass;
      button.textContent = 'Copy GoonBox links';
      let reset;
      button.addEventListener('click', () => {
        const links = postLinks(post);
        clearTimeout(reset);
        try {
          if (links.length) GM_setClipboard(links.join('\n'), 'text');
          button.textContent = links.length ? `Copied ${links.length} GoonBox link${links.length === 1 ? '' : 's'}` : 'No GoonBox links found';
        } catch {
          button.textContent = 'Could not copy links';
        }
        reset = setTimeout(() => { button.textContent = 'Copy GoonBox links'; }, 2500);
      });
      actions.append(button);
    }
  }

  let pending = false;
  new MutationObserver(records => {
    if (pending || !records.some(record => [...record.addedNodes].some(node =>
      node.nodeType === Node.ELEMENT_NODE && (node.matches(postSelector) || node.querySelector(postSelector) ||
        (node.closest(postSelector) && (node.matches(contentSelector) || node.querySelector(contentSelector))))
    ))) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      addButtons();
    });
  }).observe(document.body, { childList: true, subtree: true });

  addButtons();
})();
