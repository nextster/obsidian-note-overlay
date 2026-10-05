function createNoteSidebar({ document, container, getFiles, getActivePath, onOpen, setIcon, focusEditor, state, onStateChange = () => {} }) {
  state = state || {};
  const expanded = new Set(Array.isArray(state.expandedFolders) ? state.expandedFolders.filter(path => typeof path === 'string') : []);
  let visible = state.visible === true;
  let disposed = false;
  let hasShown = false;
  let activePath = null;
  let lastRevealedPath = null;
  let pendingReveal = false;
  let focusPath = null;
  let entries = new Map();
  let rows = [];
  let root = { children: [] };
  const originalRoot = container.firstElementChild;
  const element = document.createElement('aside');
  element.className = 'note-panel-sidebar';
  element.setAttribute('aria-label', 'Заметки');
  const header = document.createElement('div');
  header.className = 'note-panel-sidebar-header';
  const title = document.createElement('span');
  title.textContent = 'Заметки';
  const close = document.createElement('button');
  close.className = 'note-panel-sidebar-close clickable-icon';
  close.type = 'button';
  close.title = 'Скрыть боковую панель (⌘⇧B)';
  close.setAttribute('aria-label', close.title);
  if (setIcon) setIcon(close, 'panel-left-close');
  else close.textContent = '‹';
  header.append(title, close);
  const tree = document.createElement('div');
  tree.className = 'note-panel-sidebar-tree';
  tree.setAttribute('role', 'tree');
  tree.setAttribute('aria-label', 'Заметки хранилища');
  element.append(header, tree);
  const style = document.createElement('style');
  style.textContent = `
    .note-panel-sidebar { display:flex;flex-direction:column;flex:0 0 auto;width:220px;max-width:38%;min-width:0;min-height:0;overflow:hidden;border-right:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-normal);font-size:var(--font-ui-small);-webkit-app-region:no-drag; }
    .note-panel-sidebar[hidden] { display:none; }
    .note-panel-sidebar + * { min-width:0; }
    .note-panel-sidebar-header { display:flex;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box;height:72px;min-height:72px;padding:38px 10px 0 14px;color:var(--text-muted);font-weight:var(--font-medium); }
    .note-panel-sidebar-close { width:24px;height:24px;padding:4px;border:0;box-shadow:none;background:transparent;color:var(--text-muted); }
    .note-panel-sidebar-close:hover { background:var(--background-modifier-hover);color:var(--text-normal); }
    .note-panel-sidebar-close svg { width:16px;height:16px; }
    .note-panel-sidebar-tree { flex:1;min-height:0;overflow:auto;padding:4px 6px 10px; }
    .note-panel-sidebar-row { display:flex;align-items:center;gap:5px;min-height:28px;padding:4px 7px;border-radius:var(--radius-s);cursor:pointer;user-select:none;color:var(--text-muted);line-height:1.35;outline:none; }
    .note-panel-sidebar-row:hover { background:var(--background-modifier-hover);color:var(--text-normal); }
    .note-panel-sidebar-row.is-active { background:var(--nav-item-background-active,var(--background-modifier-hover));color:var(--nav-item-color-active,var(--text-normal)); }
    .note-panel-sidebar-row:focus-visible { box-shadow:inset 0 0 0 1px var(--interactive-accent); }
    .note-panel-sidebar-icon { display:flex;flex:0 0 14px;align-items:center;justify-content:center;color:var(--text-faint); }
    .note-panel-sidebar-icon svg { width:14px;height:14px; }
    .note-panel-sidebar-row[aria-expanded="true"] .note-panel-sidebar-chevron { transform:rotate(90deg); }
    .note-panel-sidebar-label { overflow:hidden;white-space:nowrap;text-overflow:ellipsis; }
    .note-panel-sidebar-empty { padding:10px 8px;color:var(--text-faint); }
  `;
  document.head.appendChild(style);
  container.insertBefore(element, container.firstChild);

  const getState = () => ({ visible, expandedFolders: [...expanded].sort() });
  const notify = () => onStateChange(getState());
  const icon = (name, className = '') => {
    const node = document.createElement('span');
    node.className = `note-panel-sidebar-icon ${className}`.trim();
    node.setAttribute('aria-hidden', 'true');
    if (setIcon) setIcon(node, name);
    else if (name === 'chevron-right') node.textContent = '›';
    return node;
  };
  const readActivePath = () => getActivePath?.() || null;
  const revealActive = () => {
    const entry = entries.get(activePath);
    let changed = false;
    if (entry?.kind === 'file') {
      let parent = entry.parent;
      while (parent) {
        if (!expanded.has(parent.path)) { expanded.add(parent.path); changed = true; }
        parent = parent.parent;
      }
    }
    lastRevealedPath = activePath;
    hasShown = true;
    pendingReveal = entry?.kind === 'file';
    return changed;
  };
  const updateTabStops = () => {
    for (const row of rows) row.element.tabIndex = row.path === focusPath ? 0 : -1;
    tree.tabIndex = rows.length ? -1 : 0;
  };
  const render = () => {
    const scrollTop = tree.scrollTop;
    const focused = tree.contains(document.activeElement);
    const previousIndex = Math.max(0, rows.findIndex(row => row.path === focusPath));
    rows = [];
    const children = [];
    const walk = (parent, depth) => {
      parent.children.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'note-panel-sidebar-row';
        row.dataset.path = entry.path;
        row.dataset.kind = entry.kind;
        row.title = entry.path;
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', String(depth + 1));
        row.setAttribute('aria-posinset', String(index + 1));
        row.setAttribute('aria-setsize', String(parent.children.length));
        row.style.paddingLeft = `${7 + depth * 14}px`;
        if (entry.kind === 'folder') {
          row.setAttribute('aria-expanded', String(expanded.has(entry.path)));
          row.append(icon('chevron-right', 'note-panel-sidebar-chevron'), icon('folder'));
        } else {
          const isActive = entry.path === activePath;
          row.classList.toggle('is-active', isActive);
          row.setAttribute('aria-selected', String(isActive));
          row.append(icon('file-text'));
        }
        const label = document.createElement('span');
        label.className = 'note-panel-sidebar-label';
        label.textContent = entry.name;
        row.append(label);
        rows.push({ ...entry, element: row });
        children.push(row);
        if (entry.kind === 'folder' && expanded.has(entry.path)) walk(entry, depth + 1);
      });
    };
    walk(root, 0);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'note-panel-sidebar-empty';
      empty.textContent = 'Нет Markdown-заметок';
      children.push(empty);
    }
    tree.replaceChildren(...children);
    if (!rows.some(row => row.path === focusPath)) {
      focusPath = rows.find(row => row.path === activePath)?.path || rows[Math.min(previousIndex, rows.length - 1)]?.path || null;
    }
    updateTabStops();
    if (focused) (rows.find(row => row.path === focusPath)?.element || tree).focus({ preventScroll: true });
    tree.scrollTop = scrollTop;
    if (visible && pendingReveal) {
      rows.find(row => row.path === activePath)?.element.scrollIntoView?.({ block: 'nearest' });
      pendingReveal = false;
    }
  };
  const focus = path => {
    const row = rows.find(row => row.path === path);
    if (!row) return;
    focusPath = path;
    updateTabStops();
    row.element.focus();
  };
  const toggleFolder = entry => {
    if (expanded.has(entry.path)) expanded.delete(entry.path);
    else expanded.add(entry.path);
    render();
    notify();
  };
  const open = entry => {
    void Promise.resolve().then(() => { if (!disposed) return onOpen(entry.file); }).then(() => syncActive()).catch(error => {
      document.defaultView?.console?.error('Could not open sidebar note', error);
    });
  };
  const eventEntry = event => {
    const row = event.target?.closest?.('.note-panel-sidebar-row');
    return row && tree.contains(row) ? entries.get(row.dataset.path) : null;
  };
  const onClick = event => {
    const entry = eventEntry(event);
    if (!entry || event.button > 0) return;
    event.preventDefault();
    event.stopPropagation();
    focus(entry.path);
    if (entry.kind === 'folder') toggleFolder(entry);
    else open(entry);
  };
  const onFocus = event => {
    const entry = eventEntry(event);
    if (entry) { focusPath = entry.path; updateTabStops(); }
  };
  const onKey = event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const entry = eventEntry(event) || entries.get(focusPath);
    if (!entry) return;
    const index = rows.findIndex(row => row.path === entry.path);
    switch (event.key) {
      case 'ArrowDown': focus(rows[Math.min(index + 1, rows.length - 1)]?.path); break;
      case 'ArrowUp': focus(rows[Math.max(index - 1, 0)]?.path); break;
      case 'Home': focus(rows[0]?.path); break;
      case 'End': focus(rows.at(-1)?.path); break;
      case 'ArrowRight':
        if (entry.kind === 'folder') {
          if (!expanded.has(entry.path)) toggleFolder(entry);
          else focus(entry.children[0]?.path);
        }
        break;
      case 'ArrowLeft':
        if (entry.kind === 'folder' && expanded.has(entry.path)) toggleFolder(entry);
        else if (entry.parent) focus(entry.parent.path);
        break;
      case 'Enter':
      case ' ':
        if (entry.kind === 'folder') toggleFolder(entry);
        else open(entry);
        break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const setVisible = value => {
    if (disposed || visible === Boolean(value)) return;
    const hadFocus = element.contains(document.activeElement);
    visible = Boolean(value);
    element.hidden = !visible;
    if (visible) {
      activePath = readActivePath();
      if (!hasShown || lastRevealedPath !== activePath) revealActive();
      render();
    } else if (hadFocus) {
      if (focusEditor) focusEditor();
      else originalRoot?.querySelector?.('.cm-content, textarea, [contenteditable="true"]')?.focus();
    }
    notify();
  };
  const syncActive = () => {
    if (disposed) return;
    const nextPath = readActivePath();
    if (nextPath === activePath) return;
    activePath = nextPath;
    const changed = visible && revealActive();
    render();
    if (changed) notify();
  };
  const refresh = () => {
    if (disposed) return;
    root = { children: [] };
    entries = new Map();
    for (const file of getFiles() || []) {
      if (typeof file?.path !== 'string' || !/\.md$/i.test(file.path)) continue;
      const segments = file.path.split('/');
      let parent = root;
      let path = '';
      segments.slice(0, -1).forEach(name => {
        path = path ? `${path}/${name}` : name;
        let folder = entries.get(path);
        if (!folder) {
          folder = { kind: 'folder', path, name, parent: parent === root ? null : parent, children: [] };
          entries.set(path, folder);
          parent.children.push(folder);
        }
        parent = folder;
      });
      if (entries.has(file.path)) continue;
      const entry = { kind: 'file', path: file.path, name: file.basename || segments.at(-1).replace(/\.md$/i, ''), parent: parent === root ? null : parent, file };
      entries.set(entry.path, entry);
      parent.children.push(entry);
    }
    const sort = node => {
      node.children.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path));
      node.children.filter(entry => entry.kind === 'folder').forEach(sort);
    };
    sort(root);
    let changed = false;
    for (const path of expanded) {
      if (entries.get(path)?.kind !== 'folder') { expanded.delete(path); changed = true; }
    }
    activePath = readActivePath();
    if (visible && (!hasShown || lastRevealedPath !== activePath)) changed = revealActive() || changed;
    render();
    if (changed) notify();
  };
  const onClose = () => setVisible(false);
  tree.addEventListener('click', onClick);
  tree.addEventListener('keydown', onKey);
  tree.addEventListener('focusin', onFocus);
  close.addEventListener('click', onClose);
  element.hidden = !visible;
  refresh();
  return {
    element, refresh, syncActive, setVisible, getState,
    dispose() {
      if (disposed) return;
      disposed = true;
      tree.removeEventListener('click', onClick);
      tree.removeEventListener('keydown', onKey);
      tree.removeEventListener('focusin', onFocus);
      close.removeEventListener('click', onClose);
      element.remove();
      style.remove();
    },
  };
}

module.exports = { createNoteSidebar };
