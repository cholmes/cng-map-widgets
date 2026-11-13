// Gazetteer picker — a small ⚙ button (top-right of the map) that opens a
// panel for switching which published cloud-native gazetteer the page's
// geocoder reads. Zero dependencies, zero build; copy this file into your
// own app and adjust GAZETTEERS.
//
// Contract: the picker only manages the page's `?index=` URL parameter
// (the same scheme the geocoder-demo documents: no param = the default
// gazetteer, 'overture' / 'wof' = the other published ones, anything
// containing '/' = a custom manifest URL). Choosing an entry rewrites the
// parameter and reloads the page; the page's own startup code resolves
// the parameter into a Geocoder `indexUrl` exactly as it already does.
// Reload-on-switch keeps this dumb and honest — the choice is shareable
// and bookmarkable because it lives in the URL, and the page rebuilds its
// Geocoder from scratch rather than trying to hot-swap index state.

/** The three published gazetteers, in default-first order. */
export const GAZETTEERS = [
  {
    param: null, // no ?index= -> the page default
    name: 'geoBoundaries',
    blurb: '52,398 names · ADM0–2 · CC-BY-4.0',
  },
  {
    param: 'overture',
    name: 'Overture',
    blurb: '5,604,413 names · 5 levels · multilingual · ODbL (share-alike)',
  },
  {
    param: 'wof',
    name: "Who's On First",
    blurb: '9,478,779 names · levels 0–5 · mixed open licenses',
  },
];

/** The current `?index=` value, or null when the page default is active. */
export function currentIndexParam() {
  return new URLSearchParams(location.search).get('index');
}

function applyParam(param) {
  const search = new URLSearchParams(location.search);
  if (param === null || param === '') search.delete('index');
  else search.set('index', param);
  const qs = search.toString();
  location.href = location.pathname + (qs ? `?${qs}` : '') + location.hash;
}

const CSS = `
.cnmw-gaz-picker { position: absolute; top: 12px; right: 12px; z-index: 6; font: 13px/1.4 system-ui, sans-serif; }
.cnmw-gaz-gear {
  width: 30px; height: 30px; border-radius: 50%; cursor: pointer; font-size: 16px; line-height: 1;
  color: #444; background: #fff; border: 1px solid #ccc; box-shadow: 0 1px 4px rgba(0,0,0,0.15); padding: 0;
}
.cnmw-gaz-gear:hover, .cnmw-gaz-gear:focus { color: #000; }
.cnmw-gaz-gear:focus { outline: 2px solid #1a73e8; outline-offset: 1px; }
.cnmw-gaz-panel {
  position: absolute; top: 36px; right: 0; width: 280px; background: #fff; border: 1px solid #ccc;
  border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,0.2); padding: 6px;
}
.cnmw-gaz-panel[hidden] { display: none; }
.cnmw-gaz-panel h3 { margin: 2px 6px 6px; font-size: 12px; color: #666; font-weight: 600; }
.cnmw-gaz-option { display: block; width: 100%; text-align: left; background: none; border: 0; border-radius: 4px;
  padding: 6px 8px; cursor: pointer; font: inherit; }
.cnmw-gaz-option:hover, .cnmw-gaz-option:focus { background: #f0f4fc; }
.cnmw-gaz-option[aria-pressed="true"] { background: #e8f0fe; }
.cnmw-gaz-option .cnmw-gaz-name { font-weight: 600; }
.cnmw-gaz-option[aria-pressed="true"] .cnmw-gaz-name::after { content: " ✓"; color: #1a73e8; }
.cnmw-gaz-option .cnmw-gaz-blurb { display: block; font-size: 11px; color: #666; }
.cnmw-gaz-custom { display: flex; gap: 4px; margin: 6px 6px 2px; }
.cnmw-gaz-custom input { flex: 1; font: inherit; font-size: 11px; padding: 4px 6px; border: 1px solid #ccc; border-radius: 4px; }
.cnmw-gaz-custom button { font: inherit; font-size: 11px; padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px;
  background: #fff; cursor: pointer; }
.cnmw-gaz-custom button:hover { background: #f0f4fc; }
`;

let cssInjected = false;

/**
 * Mount the picker. Call once, any time after `document.body` exists.
 * @param {{ container?: HTMLElement, gazetteers?: typeof GAZETTEERS }} [opts]
 * @returns {{ remove(): void }}
 */
export function mountGazetteerPicker(opts = {}) {
  const { container = document.body, gazetteers = GAZETTEERS } = opts;
  if (!cssInjected) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    cssInjected = true;
  }

  const current = currentIndexParam();
  const host = document.createElement('div');
  host.className = 'cnmw-gaz-picker';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'cnmw-gaz-gear';
  gear.textContent = '⚙';
  gear.setAttribute('aria-label', 'Choose gazetteer');
  gear.title = 'Choose gazetteer';
  gear.setAttribute('aria-expanded', 'false');

  const panel = document.createElement('div');
  panel.className = 'cnmw-gaz-panel';
  panel.hidden = true;
  panel.id = 'cnmw-gaz-panel';
  gear.setAttribute('aria-controls', panel.id);

  const heading = document.createElement('h3');
  heading.textContent = 'Gazetteer';
  panel.appendChild(heading);

  // The custom-URL case: ?index= holds something with a '/', which matches
  // none of the named entries.
  const isCustom = Boolean(current && current.includes('/'));

  for (const g of gazetteers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cnmw-gaz-option';
    const active = g.param === null ? !current : current === g.param;
    btn.setAttribute('aria-pressed', String(active));
    const name = document.createElement('span');
    name.className = 'cnmw-gaz-name';
    name.textContent = g.name;
    const blurb = document.createElement('span');
    blurb.className = 'cnmw-gaz-blurb';
    blurb.textContent = g.blurb;
    btn.appendChild(name);
    btn.appendChild(blurb);
    btn.addEventListener('click', () => applyParam(g.param));
    panel.appendChild(btn);
  }

  const custom = document.createElement('div');
  custom.className = 'cnmw-gaz-custom';
  const customInput = document.createElement('input');
  customInput.type = 'url';
  customInput.placeholder = 'Custom manifest URL (index.json)';
  customInput.setAttribute('aria-label', 'Custom manifest URL');
  if (isCustom) customInput.value = current;
  const customGo = document.createElement('button');
  customGo.type = 'button';
  customGo.textContent = 'Go';
  const applyCustom = () => {
    const url = customInput.value.trim();
    if (url && url.includes('/')) applyParam(url);
  };
  customGo.addEventListener('click', applyCustom);
  customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustom(); });
  custom.appendChild(customInput);
  custom.appendChild(customGo);
  panel.appendChild(custom);

  const setOpen = (open) => {
    panel.hidden = !open;
    gear.setAttribute('aria-expanded', String(open));
  };
  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(panel.hidden);
  });
  const onOutside = (e) => { if (!host.contains(e.target)) setOpen(false); };
  const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
  document.addEventListener('click', onOutside);
  document.addEventListener('keydown', onKey);

  host.appendChild(gear);
  host.appendChild(panel);
  container.appendChild(host);

  return {
    remove() {
      document.removeEventListener('click', onOutside);
      document.removeEventListener('keydown', onKey);
      host.remove();
    },
  };
}
