// Websidian's browser entry for OpenClaw's Control UI.
//
// The Gateway loads this module in the Control UI document and calls activate(host) — see
// openclaw/dist/plugin-sdk/control-ui.d.ts. `defineControlUiPlugin` from that SDK is the identity
// function, and importing it here would be a bare specifier the browser cannot resolve, so the default
// export is written out in the shape the loader checks for: an object whose `id` matches the plugin
// manifest and whose `activate` is a function.
//
// What it contributes:
//   - a "Memory" page (id "memory"), the same id the backend's Control UI tab descriptor uses, so the
//     sidebar entry the descriptor creates opens this native view instead of framing the route;
//   - a "Memory" navigation item, for a host that renders navigation but no plugin tabs.
//
// Everything else — the write guard, the links footer, /brain, websidian_links and the stand-alone pages
// at /plugins/websidian/ — lives in the backend plugin and does not depend on this file at all.
import { mountMemoryPage } from './memory-page.js';

export const PAGE_ID = 'memory';

export function activate(host) {
  const disposers = [];
  const add = (disposer) => { if (typeof disposer === 'function') disposers.push(disposer); };

  add(host.ui.registerPage({
    id: PAGE_ID,
    label: 'Memory',
    mount: (container, context) => mountMemoryPage(container, context),
  }));

  // A host that already shows our tab descriptor will list "Memory" once; one that does not gets the
  // destination from here. Registering both is safe — the id is the same destination either way.
  if (typeof host.ui.registerNavigation === 'function') {
    add(host.ui.registerNavigation({
      id: PAGE_ID,
      label: 'Memory',
      icon: 'brain',
      page: { id: PAGE_ID },
      order: 20,
    }));
  }

  return () => { for (const disposer of disposers.reverse()) { try { disposer(); } catch { /* the host is tearing down */ } } };
}

export default { id: 'websidian', activate };
