import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const STATUS_PREFIX = "pi-btw:";
const WIDGET_PREFIX = "pi-btw:";

const REJECTED_UI = new Set([
  "setFooter",
  "setHeader",
  "setTitle",
  "setWorkingMessage",
  "setWorkingVisible",
  "setWorkingIndicator",
  "setHiddenThinkingLabel",
  "setEditorComponent",
  "setTheme",
  "setToolsExpanded",
  "setEditorText",
  "pasteToEditor",
  "addAutocompleteProvider",
]);

/**
 * Parent UI is process-global. Track transient keyed mutations and reject chrome that would
 * permanently reshape the main TUI after the side closes.
 */
export function createSideUi(parent: ExtensionUIContext): {
  ui: ExtensionUIContext;
  restore: () => void;
} {
  const statuses = new Set<string>();
  const widgets = new Set<string>();
  const reject = (action: string) => {
    throw new Error(`${action} is unavailable inside an ephemeral side conversation`);
  };

  const ui = new Proxy(parent, {
    get(target, property, receiver) {
      if (property === "setStatus") {
        return (key: string, text: string | undefined) => {
          const scoped = `${STATUS_PREFIX}${key}`;
          if (text === undefined) statuses.delete(scoped);
          else statuses.add(scoped);
          target.setStatus(scoped, text);
        };
      }
      if (property === "setWidget") {
        return (key: string, content: unknown, options?: unknown) => {
          const scoped = `${WIDGET_PREFIX}${key}`;
          if (content === undefined) widgets.delete(scoped);
          else widgets.add(scoped);
          return (target.setWidget as (k: string, c: unknown, o?: unknown) => void)(scoped, content, options);
        };
      }
      if (typeof property === "string" && REJECTED_UI.has(property)) {
        return () => reject(property);
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });

  return {
    ui,
    restore: () => {
      for (const key of statuses) parent.setStatus(key, undefined);
      statuses.clear();
      for (const key of widgets) parent.setWidget(key, undefined);
      widgets.clear();
    },
  };
}
