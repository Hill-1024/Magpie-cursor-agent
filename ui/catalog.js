// Fallback catalogue for the Agents-page panel. The plugin host replaces this
// with ui/catalog.runtime.js as soon as Cursor · Magpie Bridge is connected.
globalThis.CursorBridgeCatalog = globalThis.CursorBridgeCatalog || {
  enabled: false,
  defaultModel: '',
  models: [],
  roles: {},
  sources: {},
  status: null,
};
