const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('thread 404 disables the correct update controls while temporary errors remain retryable', () => {
  const nodes = new Map();
  function node() {
    const classes = new Set();
    return { handlers: {}, children: [], style: {}, parentElement: { setAttribute() {} }, lastElementChild: {},
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute(name, value) { this[name] = value; },
      append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, pause() {}, load() {}, removeAttribute() {} };
  }
  const context = vm.createContext({ document: { querySelector(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, querySelectorAll() { return []; }, createElement: node, addEventListener() {} },
    Image: function () { return node(); }, location: { hash: '' }, window: { addEventListener() {} }, localStorage: { getItem() { return null; } }, fetch: () => new Promise(() => {}), setInterval() {}, Intl });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext(`albums = [{ id:'first', name:'First', set:'First', model:'', count:1, kind:'4chan', source:{board:'wg',threadId:'1'} }, { id:'second', name:'Second', set:'Second', model:'', count:1, kind:'4chan', source:{board:'wg',threadId:'2'} }]; currentAlbum = albums[0]; updatingAlbumId = 'first'; renderDownload({ status:'error', errorCode:'THREAD_NOT_FOUND', message:'Unavailable', log:[] });`, context);
  assert.equal(nodes.get('#update-thread').disabled, true);
  assert.equal(nodes.get('#update-thread').classList.contains('unavailable'), true);
  assert.match(nodes.get('#thread-update-message').textContent, /saved gallery is unchanged/);
  const cards = nodes.get('#thread-grid').children;
  assert.equal(cards[0].children[1].disabled, true);
  assert.equal(cards[1].children[1].disabled, false);
  vm.runInContext(`currentAlbum = albums[1]; updatingAlbumId = 'second'; renderDownload({ status:'error', message:'Temporary error', log:[] });`, context);
  assert.equal(nodes.get('#update-thread').disabled, false);
  assert.equal(nodes.get('#update-thread').classList.contains('unavailable'), false);
  assert.match(nodes.get('#thread-update-message').textContent, /try updating again/);
});
