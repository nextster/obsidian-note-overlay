const test = require('node:test');
const assert = require('node:assert/strict');
const { createNoteSidebar } = require('./panel-sidebar.cjs');

class Element {
  constructor(document, tag) {
    this.ownerDocument = document;
    this.tagName = tag;
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.scrollTop = 0;
    this.textContent = '';
    this.classList = {
      contains: name => this.className.split(' ').includes(name),
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        if (enabled) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      },
    };
  }
  get firstChild() { return this.children[0] || null; }
  get firstElementChild() { return this.firstChild; }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) { this.insertBefore(node, null); return node; }
  insertBefore(node, before) {
    node.remove();
    node.parentElement = this;
    if (before) this.children.splice(this.children.indexOf(before), 0, node);
    else this.children.push(node);
  }
  replaceChildren(...nodes) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[')) {
      const [, key, value] = selector.match(/^\[([^=]+)="([^"]*)"\]$/) || [];
      return Boolean(key) && this.getAttribute(key) === value;
    }
    return this.tagName === selector;
  }
  closest(selector) {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) || null;
  }
  querySelectorAll(selector) {
    const matches = [];
    const selectors = selector.split(',').map(value => value.trim());
    const walk = node => {
      for (const child of node.children) {
        if (selectors.some(value => child.matches(value))) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  emit(type, fields = {}) {
    const event = {
      type, target: this, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      ...fields,
    };
    let node = this;
    while (node) {
      for (const handler of node.listeners.get(type) || []) handler(event);
      if (event.stopped) break;
      node = node.parentElement;
    }
    return event;
  }
  focus() { this.ownerDocument.activeElement = this; this.emit('focusin'); }
  scrollIntoView(options) { this.scrolledIntoView = options; }
}

function harness({ files = ['Zulu.md', 'notes/Note 10.md', 'notes/Note 2.md', 'alpha/A.md', 'attachment.png'], activePath = null, state, focusEditor } = {}) {
  const errors = [];
  const document = { defaultView: { console: { error: (...args) => errors.push(args) } } };
  document.createElement = tag => new Element(document, tag);
  document.head = document.createElement('head');
  const container = document.createElement('div');
  const root = document.createElement('div');
  root.className = 'workspace-split';
  const editor = document.createElement('div');
  editor.className = 'cm-content';
  root.append(editor);
  container.append(root);
  editor.focus();
  const fixture = {
    files: files.map(path => ({ path, basename: path.split('/').at(-1).replace(/\.md$/i, '') })),
    activePath, opened: [], changes: [], errors, document, container, root, editor,
  };
  fixture.sidebar = createNoteSidebar({
    document, container, state, focusEditor,
    getFiles: () => fixture.files,
    getActivePath: () => fixture.activePath,
    onOpen: async file => { fixture.opened.push(file); fixture.activePath = file.path; },
    setIcon: (node, name) => { node.icon = name; },
    onStateChange: value => fixture.changes.push(value),
  });
  fixture.tree = fixture.sidebar.element.querySelector('.note-panel-sidebar-tree');
  fixture.rows = () => fixture.tree.querySelectorAll('.note-panel-sidebar-row');
  fixture.paths = () => fixture.rows().map(row => row.dataset.path);
  fixture.row = path => fixture.rows().find(row => row.dataset.path === path);
  fixture.label = path => fixture.row(path)?.querySelector('.note-panel-sidebar-label');
  fixture.key = (path, key, fields = {}) => fixture.row(path).emit('keydown', { key, ...fields });
  return fixture;
}

test('hidden by default, folders precede naturally sorted Markdown notes, labels are literal text', () => {
  const h = harness({ files: ['Zulu.md', 'notes/Note 10.md', 'notes/Note 2.md', 'alpha/A.md', '<img onerror=x>.md', 'asset.png'] });
  assert.equal(h.sidebar.element.hidden, true);
  assert.equal(h.container.firstChild, h.sidebar.element);
  assert.equal(h.container.children[1], h.root);
  assert.deepEqual(h.paths(), ['alpha', 'notes', '<img onerror=x>.md', 'Zulu.md']);
  h.sidebar.setVisible(true);
  h.row('notes').emit('click');
  assert.deepEqual(h.paths(), ['alpha', 'notes', 'notes/Note 2.md', 'notes/Note 10.md', '<img onerror=x>.md', 'Zulu.md']);
  assert.deepEqual(h.sidebar.getState(), { visible: true, expandedFolders: ['notes'] });
  assert.equal(h.label('<img onerror=x>.md').textContent, '<img onerror=x>');
  assert.equal(h.label('<img onerror=x>.md').children.length, 0);
  assert.equal(h.document.activeElement, h.row('notes'));
  assert.equal(h.row('notes').getAttribute('aria-expanded'), 'true');
});

test('first show reveals the active note; manual collapse survives refresh and reopening until active changes', () => {
  const h = harness({ files: ['A/deep/current.md', 'B/other.md'], activePath: 'A/deep/current.md' });
  assert.deepEqual(h.sidebar.getState(), { visible: false, expandedFolders: [] });
  h.sidebar.setVisible(true);
  assert.deepEqual(h.paths(), ['A', 'A/deep', 'A/deep/current.md', 'B']);
  assert.equal(h.row('A/deep/current.md').getAttribute('aria-selected'), 'true');
  assert.equal(h.row('A/deep/current.md').classList.contains('is-active'), true);
  assert.deepEqual(h.row('A/deep/current.md').scrolledIntoView, { block: 'nearest' });
  h.row('A').emit('click');
  h.sidebar.syncActive();
  h.sidebar.refresh();
  h.sidebar.setVisible(false);
  h.sidebar.setVisible(true);
  assert.deepEqual(h.paths(), ['A', 'B']);
  assert.deepEqual(h.sidebar.getState().expandedFolders, ['A/deep']);
  h.activePath = 'B/other.md';
  h.sidebar.syncActive();
  assert.deepEqual(h.paths(), ['A', 'B', 'B/other.md']);
  assert.deepEqual(h.row('B/other.md').scrolledIntoView, { block: 'nearest' });
  h.activePath = 'A/deep/current.md';
  h.sidebar.syncActive();
  assert.deepEqual(h.sidebar.getState().expandedFolders, ['A', 'A/deep', 'B']);
  assert.equal(h.row('B/other.md').getAttribute('aria-selected'), 'false');
});

test('restored folders are normalized and initial visible state reveals active ancestors', () => {
  const h = harness({ files: ['A/deep/current.md', 'B/other.md'], activePath: 'A/deep/current.md', state: { visible: true, expandedFolders: ['B', 'missing', 'B', 3] } });
  assert.equal(h.sidebar.element.hidden, false);
  assert.deepEqual(h.sidebar.getState(), { visible: true, expandedFolders: ['A', 'A/deep', 'B'] });
  const state = h.sidebar.getState();
  state.expandedFolders.length = 0;
  assert.deepEqual(h.sidebar.getState().expandedFolders, ['A', 'A/deep', 'B']);
});

test('refresh keeps scroll and focused paths, handles added and renamed notes, and prunes deleted folders', () => {
  const h = harness({ files: ['A/one.md', 'B/two.md'], state: { visible: true, expandedFolders: ['A', 'B'] } });
  h.row('A/one.md').focus();
  h.tree.scrollTop = 74;
  h.files.push({ path: 'A/new.md', basename: 'new' });
  h.sidebar.refresh();
  assert.equal(h.document.activeElement, h.row('A/one.md'));
  assert.equal(h.tree.scrollTop, 74);
  h.files[0] = { path: 'C/renamed.md', basename: 'renamed' };
  h.activePath = 'C/renamed.md';
  h.sidebar.refresh();
  assert.equal(h.row('C/renamed.md').getAttribute('aria-selected'), 'true');
  assert.ok(h.tree.contains(h.document.activeElement));
  h.files = h.files.filter(file => !file.path.startsWith('B/'));
  h.sidebar.refresh();
  assert.deepEqual(h.sidebar.getState().expandedFolders, ['A', 'C']);
  h.files = [];
  h.activePath = null;
  h.sidebar.refresh();
  assert.deepEqual(h.paths(), []);
  assert.deepEqual(h.sidebar.getState().expandedFolders, []);
  assert.equal(h.tree.tabIndex, 0);
  assert.equal(h.document.activeElement, h.tree);
});

test('arrow keys manage folders and focus, Enter and Space open the original file in the caller', async () => {
  const h = harness({ files: ['A/one.md', 'A/two.md', 'root.md'], state: { visible: true } });
  h.row('A').focus();
  assert.equal(h.key('A', 'ArrowRight').prevented, true);
  assert.equal(h.row('A').getAttribute('aria-expanded'), 'true');
  h.key('A', 'ArrowRight');
  assert.equal(h.document.activeElement, h.row('A/one.md'));
  h.key('A/one.md', 'ArrowDown');
  assert.equal(h.document.activeElement, h.row('A/two.md'));
  h.key('A/two.md', 'ArrowLeft');
  assert.equal(h.document.activeElement, h.row('A'));
  h.key('A', 'ArrowLeft');
  assert.equal(h.row('A').getAttribute('aria-expanded'), 'false');
  h.key('A', 'End');
  assert.equal(h.document.activeElement, h.row('root.md'));
  h.key('root.md', 'Home');
  assert.equal(h.document.activeElement, h.row('A'));
  h.key('A', ' ');
  h.key('A/one.md', 'Enter');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.opened[0], h.files[0]);
  assert.equal(h.row('A/one.md').getAttribute('aria-selected'), 'true');
  h.key('A/two.md', ' ');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.opened[1], h.files[1]);
  assert.equal(h.key('root.md', 'b', { metaKey: true }).prevented, false);
  assert.equal(h.errors.length, 0);
});

test('clicking labels opens notes; hiding restores editor focus and disposal keeps persisted state', async () => {
  const h = harness({ files: ['one.md'], state: { visible: true } });
  h.label('one.md').emit('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.opened[0], h.files[0]);
  const close = h.sidebar.element.querySelector('.note-panel-sidebar-close');
  close.focus();
  close.emit('click');
  assert.equal(h.sidebar.element.hidden, true);
  assert.equal(h.document.activeElement, h.editor);
  assert.deepEqual(h.changes.at(-1), { visible: false, expandedFolders: [] });
  h.sidebar.setVisible(true);
  h.sidebar.dispose();
  h.sidebar.dispose();
  assert.deepEqual(h.sidebar.getState(), { visible: true, expandedFolders: [] });
  assert.equal(h.container.firstChild, h.root);
  assert.equal(h.document.head.children.length, 0);
  assert.equal([...h.tree.listeners.values()].every(listeners => listeners.size === 0), true);
  assert.equal([...close.listeners.values()].every(listeners => listeners.size === 0), true);
  h.sidebar.refresh();
  h.sidebar.syncActive();
  h.sidebar.setVisible(false);
  assert.equal(h.document.head.children.length, 0);
  assert.deepEqual(h.sidebar.getState(), { visible: true, expandedFolders: [] });
});

test('header close uses the supplied active-editor callback; null state is accepted', () => {
  let focused = 0;
  const h = harness({ state: null, focusEditor: () => { focused++; } });
  assert.equal(h.sidebar.element.hidden, true);
  h.sidebar.setVisible(true);
  const close = h.sidebar.element.querySelector('.note-panel-sidebar-close');
  close.focus();
  close.emit('click');
  assert.equal(focused, 1);
  assert.equal(h.sidebar.element.hidden, true);
});
