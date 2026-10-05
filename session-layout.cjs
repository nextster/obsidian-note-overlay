// Exclude only panel-owned leaves from Obsidian's persisted floating windows.
// Never identify a panel by its note path: a normal window can show the same note.
function withoutPanel(layout, panelIds) {
  if (!layout || !panelIds.size) return layout;
  const removed = new Set();
  function prune(node) {
    if (node.type === 'leaf' && panelIds.has(node.id)) {
      removed.add(node.id);
      return null;
    }
    if (!Array.isArray(node.children)) return node;
    const children = node.children.map(prune).filter(Boolean);
    if (children.every((child, i) => child === node.children[i]) && children.length === node.children.length) return node;
    if (!children.length) return null;
    const result = { ...node, children };
    if (Number.isInteger(node.currentTab)) {
      const selected = node.children[node.currentTab];
      const index = children.findIndex(child => child.id === selected?.id);
      result.currentTab = index < 0 ? Math.min(node.currentTab, children.length - 1) : index;
    }
    return result;
  }
  const floating = layout.floating ? prune(layout.floating) : null;
  if (!removed.size) return layout;
  const result = { ...layout };
  if (floating) result.floating = floating;
  else delete result.floating;
  if (removed.has(result.active)) {
    const firstLeaf = node => node?.type === 'leaf' ? node.id : node?.children?.map(firstLeaf).find(Boolean);
    const fallback = firstLeaf(layout.main);
    if (fallback) result.active = fallback;
    else delete result.active;
  }
  return result;
}
module.exports = { withoutPanel };
