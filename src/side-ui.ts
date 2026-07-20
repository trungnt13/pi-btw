import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const STATUS_PREFIX = "pi-btw:";
const WIDGET_PREFIX = "pi-btw:";

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
      if (property === "setFooter") return () => reject("setFooter");
      if (property === "setHeader") return () => reject("setHeader");
      if (property === "setTitle") return () => reject("setTitle");
      if (property === "setWorkingMessage") return () => reject("setWorkingMessage");
      if (property === "setWorkingVisible") return () => reject("setWorkingVisible");
      if (property === "setWorkingIndicator") return () => reject("setWorkingIndicator");
      if (property === "setHiddenThinkingLabel") return () => reject("setHiddenThinkingLabel");
      if (property === "setEditorComponent") return () => reject("setEditorComponent");
      if (property === "setTheme") return () => reject("setTheme");
      if (property === "setToolsExpanded") return () => reject("setToolsExpanded");
      if (property === "setEditorText") return () => reject("setEditorText");
      if (property === "pasteToEditor") return () => reject("pasteToEditor");
      if (property === "addAutocompleteProvider") return () => reject("addAutocompleteProvider");

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
