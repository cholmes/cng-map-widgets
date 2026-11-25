// @cngeo/maplibre -- keyboard and screen-reader access for the layer panel.
//
// maplibre-gl-layer-control 0.18.3 (Gate B, requirement 7) leaves three gaps:
//   - a row's checkbox has no accessible name;
//   - the drag handle cannot take focus, so reordering is mouse-only;
//   - the context menu opens from the keyboard, but its items are plain
//     <div>s with a click listener: remove, move, rename and zoom cannot be
//     reached or activated without a mouse.
//
// This module closes them from outside, by watching the panel's DOM:
//   - names each checkbox and slider after its layer;
//   - Alt+ArrowUp / Alt+ArrowDown on a row's checkbox moves the layer;
//   - turns the context menu into a real menu: role="menu"/"menuitem",
//     roving focus with the arrow keys, Enter/Space to activate, Escape to
//     close, focus returned to the row it was opened from. Shift+F10 opens it.
//
// It depends on that version's class names; the checks in
// examples/layers-demo/verify.mjs are what notice if they change.

const ROW = '.layer-control-item[data-layer-id]';
const MENU = '.layer-control-context-menu';
const ITEM = '.context-menu-item';

const nameOf = (row) => row.querySelector('.layer-control-name')?.textContent?.trim() || row.dataset.layerId;

/**
 * @param {Object} options
 * @param {HTMLElement} options.root        The map container (the panel and its menu live in it).
 * @param {(id: string, direction: 'up'|'down') => void} options.move   Move a layer one step.
 * @param {() => void} [options.closeMenu]  Hide the context menu.
 * @returns {() => void} detach
 */
export function attachPanelA11y({ root, move, closeMenu }) {
  const doc = root.ownerDocument;
  /** The layer id whose row the menu was opened from, so focus can go back to it. */
  let menuOpener = null;

  const checkboxFor = (id) => root.querySelector(`${ROW}[data-layer-id="${CSS.escape(id)}"] .layer-control-checkbox`);

  function nameRows() {
    for (const row of root.querySelectorAll(ROW)) {
      const name = nameOf(row);
      const checkbox = row.querySelector('.layer-control-checkbox');
      const slider = row.querySelector('.layer-control-opacity');
      if (checkbox && checkbox.getAttribute('aria-label') !== `Show ${name}`) checkbox.setAttribute('aria-label', `Show ${name}`);
      if (slider && slider.getAttribute('aria-label') !== `Opacity of ${name}`) slider.setAttribute('aria-label', `Opacity of ${name}`);
      const handle = row.querySelector('.layer-control-drag-handle');
      if (handle && !handle.hasAttribute('aria-hidden')) handle.setAttribute('aria-hidden', 'true');
      if (checkbox && !checkbox.hasAttribute('aria-keyshortcuts')) checkbox.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown Shift+F10');
    }
  }

  const menuItems = (menu) => [...menu.querySelectorAll(ITEM)].filter((el) => !el.hasAttribute('disabled'));

  function dressMenu() {
    const menu = root.querySelector(MENU);
    if (!menu) return;
    const open = menu.style.display !== 'none' && menu.childElementCount > 0;
    if (!open) {
      menu.removeAttribute('data-cng-dressed');
      return;
    }
    if (menu.getAttribute('data-cng-dressed') === 'true') return;
    menu.setAttribute('data-cng-dressed', 'true');
    menu.setAttribute('role', 'menu');
    for (const item of menu.querySelectorAll(ITEM)) {
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      if (item.hasAttribute('disabled')) item.setAttribute('aria-disabled', 'true');
    }
    for (const sep of menu.querySelectorAll('.context-menu-separator')) sep.setAttribute('role', 'separator');
    // Only take focus when the menu was opened from the keyboard: a mouse user
    // right-clicking should not have focus pulled away from where it was.
    if (menuOpener) menuItems(menu)[0]?.focus();
  }

  function onMenuKeydown(event) {
    const menu = event.target.closest?.(MENU);
    if (!menu) return;
    const items = menuItems(menu);
    const at = items.indexOf(doc.activeElement);
    const focus = (i) => items[(i + items.length) % items.length]?.focus();
    if (event.key === 'ArrowDown') focus(at + 1);
    else if (event.key === 'ArrowUp') focus(at - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(items.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') {
      const opener = menuOpener;
      doc.activeElement?.click?.();
      // The action usually rebuilds the list; put focus back on the row.
      queueMicrotask(() => requestAnimationFrame(() => opener && checkboxFor(opener)?.focus()));
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      const opener = menuOpener;
      closeMenu ? closeMenu() : (menu.style.display = 'none');
      menuOpener = null;
      if (opener) checkboxFor(opener)?.focus();
      if (event.key === 'Tab') return; // let Tab move on
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onRowKeydown(event) {
    const row = event.target.closest?.(ROW);
    if (!row || event.target.closest(MENU)) return;
    const id = row.dataset.layerId;
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      move(id, event.key === 'ArrowUp' ? 'up' : 'down');
      // The list is rebuilt by the move; keep focus on the same layer.
      requestAnimationFrame(() => checkboxFor(id)?.focus());
      return;
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      menuOpener = id;
      if (event.shiftKey && event.key === 'F10') {
        event.preventDefault();
        const box = row.getBoundingClientRect();
        row.querySelector('.layer-control-row')?.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 24, clientY: box.bottom - 4 }),
        );
      }
    }
  }

  const onPointerDown = () => {
    menuOpener = null; // a mouse interaction: do not steal focus for the next menu
  };

  const observer = new MutationObserver(() => {
    nameRows();
    dressMenu();
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-layer-id'] });
  root.addEventListener('keydown', onMenuKeydown, true);
  root.addEventListener('keydown', onRowKeydown);
  root.addEventListener('pointerdown', onPointerDown, true);
  nameRows();
  dressMenu();

  return () => {
    observer.disconnect();
    root.removeEventListener('keydown', onMenuKeydown, true);
    root.removeEventListener('keydown', onRowKeydown);
    root.removeEventListener('pointerdown', onPointerDown, true);
  };
}
