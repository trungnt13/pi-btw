import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";

type Registry = ExtensionContext["modelRegistry"];

function parentRuntime(registry: Registry): ModelRuntime {
  const candidate = (registry as unknown as { runtime?: unknown }).runtime;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("pi-btw requires Pi 0.80.10's shared ModelRegistry.runtime bridge");
  }
  const methods = candidate as Record<string, unknown>;
  const required = ["checkAuth", "getAvailable", "getModel", "hasConfiguredAuth", "isUsingOAuth", "streamSimple"];
  if (required.some((name) => typeof methods[name] !== "function")) {
    throw new Error("Pi ModelRegistry.runtime does not satisfy the ModelRuntime contract required by pi-btw");
  }
  return candidate as ModelRuntime;
}

/** Share parent stream/auth identity while blocking provider registry mutations from the side session. */
export function guardSharedRuntime(runtime: ModelRuntime): ModelRuntime {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      if (property === "registerProvider" || property === "unregisterProvider") {
        return () => {
          throw new Error("Provider registration is disabled inside pi-btw side sessions");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export class SideModelRuntime {
  private runtime?: ModelRuntime;

  get(registry: Registry): ModelRuntime {
    const runtime = parentRuntime(registry);
    if (this.runtime && this.runtime !== runtime) {
      throw new Error("The main conversation changed ModelRuntime identity while pi-btw was active");
    }
    this.runtime = runtime;
    return runtime;
  }

  async resolveModel(runtime: ModelRuntime, selected: Pick<Model<Api>, "provider" | "id">): Promise<Model<Api>> {
    const available = await runtime.getAvailable();
    const model = available.find(
      (candidate) => candidate.provider === selected.provider && candidate.id === selected.id,
    );
    if (!model) {
      throw new Error(`Model is unavailable for the side conversation: ${selected.provider}/${selected.id}`);
    }
    return model;
  }
}
