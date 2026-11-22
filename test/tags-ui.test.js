const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('tag filter shows matching and untagged galleries and composes with search', () => {
  const nodes = new Map();
  function node() { return { handlers: {}, children: [], style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {},
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, pause() {}, load() {}, removeAttribute() {} }; }
  const context = vm.createContext({ document: { querySelector(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, querySelectorAll() { return []; }, createElement: node, addEventListener() {} },
    Image: function () { return node(); }, location: { hash: '' }, window: { addEventListener() {} }, localStorage: { getItem() { return null; } }, fetch: () => new Promise(() => {}), setInterval() {}, Intl });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  vm.runInContext(`tagLibrary = [{ id:'one', name:'Portraits' }]; albums = [{ id:'a', name:'Alice', set:'Alice', model:'', count:1, kind:'collection', tagIds:['one'] }, { id:'b', name:'Bob', set:'Bob', model:'', count:1, kind:'collection', tagIds:[] }];`, context);
  nodes.get('#tag-filter').value = 'one'; vm.runInContext('renderAlbums()', context);
  assert.equal(nodes.get('#album-grid').children.length, 1);
  assert.match(nodes.get('#search-results').textContent, /1 of 2/);
  nodes.get('#tag-filter').value = 'untagged'; vm.runInContext('renderAlbums()', context);
  assert.equal(nodes.get('#album-grid').children.length, 1);
  nodes.get('#gallery-search').value = 'alice'; vm.runInContext('renderAlbums()', context);
  assert.equal(nodes.get('#album-grid').children.length, 0);
  assert.match(nodes.get('#search-results').textContent, /No galleries match/);
});
