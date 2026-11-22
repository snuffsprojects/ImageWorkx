const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('gallery pages bound image tiles and preserve lightbox navigation across pages', () => {
  const nodes = new Map();
  function node() {
    return {
      handlers: {}, pauses: 0, loads: 0, pause() { this.pauses++; }, load() { this.loads++; },
      children: [], style: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; }, hasAttribute(key) { return this[key] !== undefined; }, addEventListener(key, callback) { this.handlers[key] = callback; },
      append(...items) { this.children.push(...items); },
      replaceChildren() { this.children = []; },
      showModal() { this.open = true; }
    };
  }
  const context = vm.createContext({
    document: {
      querySelector(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
      querySelectorAll() { return []; }, createElement: node, addEventListener() {}
    },
    Image: function () { return node(); },
    location: { hash: '' }, window: { addEventListener() {} },
    localStorage: { getItem: () => '30', setItem(key, value) { this[key] = value; } },
    fetch: () => new Promise(() => {}), setInterval() {}, Intl
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext(`currentImages = Array.from({ length: 125 }, (_, i) => ({ name: i + '.jpg', url: '/images/' + i })); renderPhotoPage();`, context);
  assert.equal(nodes.get('#photo-grid').children.length, 30);
  assert.equal(nodes.get('#page-previous').disabled, true);
  assert.equal(nodes.get('#page-previous-bottom').disabled, true);
  assert.match(nodes.get('#page-status').textContent, /Page 1 of 5/);
  assert.deepEqual(nodes.get('#page-numbers').children.map(button => button.textContent), ['1', '2', '3', '4', '5']);
  assert.equal(nodes.get('#page-numbers').children[0]['aria-current'], 'page');
  nodes.get('#page-numbers-bottom').children[2].handlers.click();
  assert.match(nodes.get('#page-status').textContent, /Page 3 of 5/);
  assert.equal(nodes.get('#page-numbers').children[2]['aria-current'], 'page');
  assert.equal(nodes.get('#photo-grid').children.length, 30);
  nodes.get('#page-size').handlers.change({ target: { value: '60' } });
  assert.equal(context.localStorage.imageworksPageSize, '60');
  assert.equal(nodes.get('#photo-grid').children.length, 60);
  assert.match(nodes.get('#page-status').textContent, /Page 2 of 3/);
  vm.runInContext('openImage(120)', context);
  assert.match(nodes.get('#page-status').textContent, /Page 3 of 3/);
  nodes.get('#page-size').handlers.change({ target: { value: '30' } });
  assert.match(nodes.get('#page-status').textContent, /Page 5 of 5/);
  vm.runInContext('renderPhotoPage(2)', context);
  vm.runInContext('openImage(60)', context);
  assert.equal(nodes.get('#full-image').src, '/images/60');
  assert.match(nodes.get('#page-status').textContent, /Page 3 of 5/);
  vm.runInContext('renderPhotoPage(4)', context);
  assert.equal(nodes.get('#photo-grid').children.length, 5);
  assert.equal(nodes.get('#page-next').disabled, true);
  assert.equal(nodes.get('#page-next-bottom').disabled, true);
  assert.equal(nodes.get('#page-status-bottom').textContent, nodes.get('#page-status').textContent);
  nodes.get('#viewer').scrollTop = 1000;
  nodes.get('#page-previous-bottom').handlers.click();
  assert.match(nodes.get('#page-status').textContent, /Page 4 of 5/);
  assert.equal(nodes.get('#viewer').scrollTop, 0);
  nodes.get('#page-next-bottom').handlers.click();
  assert.match(nodes.get('#page-status').textContent, /Page 5 of 5/);
  assert.equal(nodes.get('#photo-grid').children.length, 5);
  vm.runInContext('openImage(125)', context);
  assert.equal(nodes.get('#full-image').src, '/images/0');
  assert.match(nodes.get('#page-status').textContent, /Page 1 of 5/);
  vm.runInContext(`currentImages[60] = { name: 'clip.webm', type: 'video', url: '/clip.webm', poster: '/poster/clip.webm' }; openImage(60);`, context);
  const video = nodes.get('#full-video');
  assert.equal(video.src, '/clip.webm');
  assert.equal(video.muted, true);
  assert.equal(video.hidden, false);
  assert.equal(video.autoplay, undefined);
  assert.equal(nodes.get('.zoom-controls').hidden, true);
  assert.equal(nodes.get('#download-original').href, '/clip.webm?download=1');
  const pauses = video.pauses;
  vm.runInContext('openImage(61)', context);
  assert.equal(video.src, undefined);
  assert.equal(video.hidden, true);
  assert.equal(video.pauses, pauses + 1);
  vm.runInContext('openImage(60)', context);
  nodes.get('#lightbox').handlers.close();
  assert.equal(video.src, undefined);
  assert.ok(video.loads > 0);
  vm.runInContext(`currentImages = Array.from({ length: 65 }, (_, i) => ({ name: i + '.jpg', relativePath: i + '.jpg', url: '/images/' + i })); renderPhotoPage(0);`, context);
  nodes.get('#select-images').handlers.click();
  nodes.get('#photo-grid').children[0].handlers.click();
  assert.equal(nodes.get('#batch-count').textContent, '1 selected');
  vm.runInContext('renderPhotoPage(1)', context);
  nodes.get('#photo-grid').children[0].handlers.click();
  assert.equal(nodes.get('#batch-count').textContent, '2 selected');
  vm.runInContext('renderPhotoPage(0)', context);
  assert.equal(nodes.get('#photo-grid').children[0]['aria-pressed'], 'true');
  nodes.get('#batch-clear').handlers.click();
  assert.equal(nodes.get('#batch-count').textContent, '0 selected');

});
