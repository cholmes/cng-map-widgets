// @cngeo/maplibre -- theming for the layer panel.
//
// maplibre-gl-layer-control ships hard-coded light colours: no CSS custom
// properties, no dark mode (Gate B, requirement 6). This stylesheet restyles
// its surfaces from the same `--cng-*` tokens the geocoder control uses, with
// the same light and dark defaults, so a page that themes one themes both.
// A host overrides any token by redeclaring it on an ancestor.
//
// It is injected AFTER the control's own stylesheet and repeats the control's
// class names, so it tracks version 0.18.3's markup. Several upstream rules
// use `!important`; the matching ones here must too.

export const TOKENS_LIGHT = `
  --cng-bg: #fff; --cng-ink: #1a1a1a; --cng-border: #ccc; --cng-focus: #1a73e8;
  --cng-meta: #666; --cng-selected-bg: #e8f0fe; --cng-shadow: rgba(0,0,0,0.15);
  --cng-error: #b3261e; --cng-error-bg: #fdecea; --cng-badge-bg: #f1f1ef; --cng-badge-ink: #777;
  --cng-on-focus: #fff;`;

export const TOKENS_DARK = `
  --cng-bg: #1e1f22; --cng-ink: #e8e8e6; --cng-border: #46484d; --cng-focus: #7ab2f5;
  --cng-meta: #a3a3a0; --cng-selected-bg: #2a3a52; --cng-shadow: rgba(0,0,0,0.5);
  --cng-error: #ff8a80; --cng-error-bg: #3a2323; --cng-badge-bg: #2d2f33; --cng-badge-ink: #b0b0ac;
  --cng-on-focus: #10151c;`;

const SCOPE = '.layer-control-panel, .layer-control-context-menu, .maplibregl-ctrl-layer-control, .cng-layer-control';

export const LAYER_CONTROL_THEME_CSS = `
${SCOPE} {${TOKENS_LIGHT}
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  ${SCOPE} {${TOKENS_DARK}
  }
}

/* Surfaces */
.layer-control-panel { background: var(--cng-bg); color: var(--cng-ink); box-shadow: 0 0 0 1px var(--cng-border), 0 2px 10px var(--cng-shadow); }
.layer-control-panel-header { color: var(--cng-ink); border-bottom-color: var(--cng-border); display: flex; align-items: center; gap: 8px; }
.layer-control-panel-title { flex: 1; }
.layer-control-actions { border-bottom-color: var(--cng-border); }
.layer-control-item, .layer-control-group-row { border-bottom-color: var(--cng-border); }
.layer-control-name, .layer-control-category { color: var(--cng-ink); }
.layer-control-drag-handle, .layer-control-group-toggle, .layer-control-categories-toggle { color: var(--cng-meta); }
.layer-control-drag-handle:hover { color: var(--cng-ink); }
.layer-control-drag-handle-disabled, .layer-control-drag-handle-disabled:hover { color: var(--cng-border); }
.maplibregl-ctrl-layer-control { background: var(--cng-bg); }
.maplibregl-ctrl-layer-control button { background-color: var(--cng-bg); color: var(--cng-ink); }
.maplibregl-ctrl-layer-control .layer-control-icon svg { color: var(--cng-ink); }

/* Buttons */
.layer-control-action-btn, .layer-control-background-legend .background-legend-action-btn, .layer-control-style-apply {
  color: var(--cng-on-focus) !important; background: var(--cng-focus) !important; border-color: var(--cng-focus) !important;
}
.layer-control-action-btn:hover, .layer-control-background-legend .background-legend-action-btn:hover { filter: brightness(0.92); }
.layer-control-style-button { background: var(--cng-bg); color: var(--cng-meta); border-color: var(--cng-border); }
.layer-control-style-button:hover, .layer-control-background-legend-button.active { background: var(--cng-selected-bg); color: var(--cng-focus); border-color: var(--cng-focus); }
.style-editor-button, .layer-control-style-reset, .layer-control-style-close-secondary, .layer-control-remove-confirm-btn-cancel {
  background: var(--cng-bg); color: var(--cng-ink); border-color: var(--cng-border);
}
.style-editor-button:hover, .layer-control-style-reset:hover, .layer-control-style-close-secondary:hover, .layer-control-remove-confirm-btn-cancel:hover {
  background: var(--cng-selected-bg); border-color: var(--cng-focus);
}

/* Sliders */
.layer-control-opacity { background: linear-gradient(to right, var(--cng-border) 0%, var(--cng-ink) 100%); }
.layer-control-opacity::-webkit-slider-thumb { background: var(--cng-bg); border-color: var(--cng-ink); }
.layer-control-opacity::-moz-range-thumb { background: var(--cng-bg); border-color: var(--cng-ink); }
.style-control-slider { background: linear-gradient(to right, var(--cng-border) 0%, var(--cng-focus) 100%); }
.style-control-slider::-webkit-slider-thumb { background: var(--cng-bg); border-color: var(--cng-focus); }
.style-control-slider::-moz-range-thumb { background: var(--cng-bg); border-color: var(--cng-focus); }

/* Editors, legends, inputs */
.layer-control-style-editor, .layer-control-background-legend, .layer-control-opacity-input {
  background: var(--cng-badge-bg); border-color: var(--cng-border); color: var(--cng-ink); box-shadow: none;
}
.style-editor-header, .background-legend-header, .style-editor-section-header, .style-editor-actions,
.background-legend-presets, .background-legend-layer-row { border-color: var(--cng-border); }
.style-editor-title, .background-legend-title, .background-legend-layer-name, .layer-control-style-header { color: var(--cng-ink); }
.style-editor-controls, .style-editor-section-header, .style-control-label, .style-control-value, .layer-style-value,
.layer-style-control label, .background-legend-filter-label, .background-legend-presets-label { color: var(--cng-ink); }
.style-control-reason, .style-control-pattern-current, .style-control-pattern-hint, .style-control-pattern-empty,
.layer-control-style-empty, .layer-control-opacity-input-label, .layer-control-opacity-input-suffix,
.background-legend-empty, .style-editor-close, .background-legend-close, .layer-control-style-close { color: var(--cng-meta); }
.style-editor-close:hover, .background-legend-close:hover { color: var(--cng-ink); }
.layer-control-opacity-input-field input, .layer-style-color-text, .style-control-color-picker, .style-control-color-value,
.style-control-number-input, .style-control-pattern-list, .background-legend-presets-select, .background-legend-presets-input,
.layer-control-name-input {
  background: var(--cng-bg); color: var(--cng-ink); border-color: var(--cng-border);
}
.style-control-pattern-option { color: var(--cng-ink); }
.style-control-pattern-option:hover:not(:disabled), .style-control-pattern-option[aria-selected="true"] { background: var(--cng-selected-bg); }
.background-legend-filter, .background-legend-layer-type, .style-control-pattern-badge { background: var(--cng-badge-bg); color: var(--cng-badge-ink); }
.layer-control-custom-info-text { color: var(--cng-meta); background: var(--cng-badge-bg); border-left-color: var(--cng-focus); }

/* Context menu */
.layer-control-context-menu { background: var(--cng-bg); box-shadow: 0 4px 16px var(--cng-shadow), 0 0 0 1px var(--cng-border); }
.context-menu-item { color: var(--cng-ink); }
.context-menu-item-icon { color: var(--cng-meta); }
.context-menu-item:hover, .context-menu-item:focus { background: var(--cng-selected-bg); }
.context-menu-item-danger, .context-menu-item-danger .context-menu-item-icon { color: var(--cng-error); }
.context-menu-item-danger:hover, .context-menu-item-danger:focus { background: var(--cng-error-bg); }
.context-menu-item[disabled] { color: var(--cng-meta); opacity: 0.6; }
.context-menu-separator { background: var(--cng-border); }

/* Drag and removal */
.layer-control-item-dragging { background: var(--cng-bg); box-shadow: 0 8px 24px var(--cng-shadow); }
.layer-control-drop-placeholder { background: var(--cng-selected-bg); border-color: var(--cng-focus); }
.layer-control-remove-confirm { background: var(--cng-error-bg); border-color: var(--cng-error); }
.layer-control-remove-confirm-message { color: var(--cng-error); }

/* Scrollbars */
.layer-control-panel::-webkit-scrollbar-track, .background-legend-layer-list::-webkit-scrollbar-track { background: var(--cng-badge-bg); }
.layer-control-panel::-webkit-scrollbar-thumb, .background-legend-layer-list::-webkit-scrollbar-thumb { background: var(--cng-border); }

/* Focus: the control sets \`outline: none\` in places; put a ring back everywhere. */
.layer-control-panel :focus-visible, .layer-control-context-menu :focus-visible, .maplibregl-ctrl-layer-control :focus-visible {
  outline: 2px solid var(--cng-focus) !important; outline-offset: 1px;
}

/* Ours: the Add button, its popover, and per-layer notes */
.cng-layer-add-btn {
  font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 4px; cursor: pointer;
  color: var(--cng-on-focus); background: var(--cng-focus); border: 1px solid var(--cng-focus);
}
.cng-layer-add-popover { padding: 8px 10px; border-bottom: 1px solid var(--cng-border); background: var(--cng-badge-bg); color: var(--cng-ink); font-size: 12px; }
.cng-layer-add-popover[hidden] { display: none; }
.cng-layer-add-popover button { font: inherit; font-size: 12px; margin: 4px 4px 0 0; padding: 3px 9px; border-radius: 4px; cursor: pointer;
  background: var(--cng-bg); color: var(--cng-ink); border: 1px solid var(--cng-border); }
.cng-layer-add-popover button[type="submit"] { background: var(--cng-focus); color: var(--cng-on-focus); border-color: var(--cng-focus); }
.cng-layer-add-url label { display: block; font-weight: 600; margin-bottom: 4px; }
.cng-layer-add-url input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 5px 6px; font: inherit; font-weight: 400;
  background: var(--cng-bg); color: var(--cng-ink); border: 1px solid var(--cng-border); border-radius: 4px; }
.cng-layer-add-status { margin-top: 6px; color: var(--cng-meta); }
.cng-layer-note { font-size: 11px; color: var(--cng-meta); padding: 0 8px 6px 34px; }
.cng-layer-note[data-status="error"] { color: var(--cng-error); }
.cng-layer-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

/** Inject the theme stylesheet once per document. */
export function injectLayerControlTheme(doc = globalThis.document) {
  if (!doc || doc.getElementById('cng-layer-control-theme')) return;
  const style = doc.createElement('style');
  style.id = 'cng-layer-control-theme';
  style.textContent = LAYER_CONTROL_THEME_CSS;
  doc.head.appendChild(style);
}
