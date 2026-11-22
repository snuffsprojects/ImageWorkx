const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('collection shows source details and removable unavailable placeholders', async () => {
  const nodes = new Map();
  function node() { return { handlers: {}, children: [], style: {}, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {}, append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; }, pause() {}, load() {}, removeAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; } }; }
  const items = [
    { id:'one', state:'available', name:'first.jpg', sourceName:'First gallery', sourceAlbumId:'First gallery', relativePath:'first.jpg', type:'image', url:'/gallery/first.jpg', preview:'/preview/first.jpg' },
    { id:'two', state:'trashed', name:'second.jpg', sourceName:'Trashed gallery' },
    { id:'three', state:'missing', name:'third.jpg', sourceName:'Missing gallery' },
    { id:'four', state:'image-trashed', name:'fourth.jpg', sourceName:'First gallery' },
    { id:'five', state:'image-deleted', name:'fifth.jpg', sourceName:'First gallery' }
  ];
  for (let i = 0; i < 18; i++) items.push({ id:'extra' + i, state:'missing', name:'extra' + i + '.jpg', sourceName:'Old gallery' });
  const context = vm.createContext({ document: { querySelector(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); }, querySelectorAll() { return []; }, createElement: node, addEventListener() {} },
    Image: function () { return node(); }, location: { hash: '' }, window: { addEventListener() {} }, localStorage: { getItem() { return null; } },
    fetch: url => url.startsWith('/api/collections?id=') ? Promise.resolve({ ok:true, json:async () => ({ collection:{ id:'favourites', name:'Favourites', items } }) }) : new Promise(() => {}), setInterval() {}, Intl });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  await vm.runInContext("openCollection('favourites')", context);
  const cards = nodes.get('#collection-items').children;
  assert.equal(cards.length, 15);
  assert.equal(nodes.get('#collection-page-label').textContent, 'Page 1 of 2');
  assert.equal(cards[0].children[1].children[0].textContent, 'first.jpg');
  assert.equal(cards[0].children[1].children[1].textContent, 'From: First gallery');
  assert.equal(cards[1].children[0].textContent, 'Source gallery is in Trash');
  assert.equal(cards[1].children[1].children[1].textContent, 'From: Trashed gallery');
  assert.equal(cards[1].children[1].children[2].textContent, 'Remove from collection');
  assert.equal(cards[2].children[0].textContent, 'Source not found');
  assert.equal(cards[3].children[0].textContent, 'Image is in Trash');
  assert.equal(cards[4].children[0].textContent, 'Image permanently deleted');
  cards[0].children[0].handlers.click();
  assert.equal(nodes.get('#full-image').src, '/gallery/first.jpg');
  assert.match(nodes.get('#caption').textContent, /First gallery/);
  assert.equal(nodes.get('#trash-image').hidden, true);
  assert.equal(nodes.get('#remove-from-collection').hidden, false);
  assert.equal(vm.runInContext('imageSource().album', context), 'First gallery');
  await nodes.get('#collection-next').handlers.click();
  assert.equal(nodes.get('#collection-items').children.length, 8);
  assert.equal(nodes.get('#collection-page-label').textContent, 'Page 2 of 2');
});
