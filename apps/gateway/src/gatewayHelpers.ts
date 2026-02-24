import type {
  ApprovalType,
  GatewayEvent,
  ModelOption,
  ThreadListItem,
  ThreadStatus,
  TurnPermissionMode,
} from "@lcwa/shared-types";

export type RawReasoningEffort = {
  effort?: unknown;
  reasoningEffort?: unknown;
  description?: unknown;
};

export type RawModel = {
  id?: unknown;
  model?: unknown;
  displayName?: unknown;
  hidden?: unknown;
  defaultReasoningEffort?: unknown;
  reasoningEffort?: unknown;
  supportedReasoningEfforts?: unknown;
  upgrade?: unknown;
  inputModalities?: unknown;
  supportsPersonality?: unknown;
  isDefault?: unknown;
};

export function statusFromRaw(raw: unknown): ThreadStatus {
  if (raw && typeof raw === "object" && "type" in (raw as Record<string, unknown>)) {
    const typeValue = (raw as Record<string, unknown>).type;
    if (typeof typeValue === "string") {
      if (typeValue === "notLoaded") return "notLoaded";
      if (typeValue === "idle") return "idle";
      if (typeValue === "active") return "active";
      if (typeValue === "systemError") return "systemError";
    }
  }

  if (typeof raw === "string") {
    if (raw === "notLoaded" || raw === "idle" || raw === "active" || raw === "systemError") {
      return raw;
    }
  }

  return "unknown";
}

export function permissionModeToTurnStartParams(
  mode?: TurnPermissionMode,
): Record<string, unknown> {
  if (mode === "full-access") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
    };
  }
  if (mode === "local") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        networkAccess: false,
      },
    };
  }
  return {};
}

export function toModelOption(raw: RawModel): ModelOption | null {
  const fallbackId = typeof raw.model === "string" ? raw.model : null;
  const id = typeof raw.id === "string" ? raw.id : fallbackId;
  if (!id) {
    return null;
  }

  const model = typeof raw.model === "string" ? raw.model : id;
  const effortListRaw = Array.isArray(raw.reasoningEffort)
    ? raw.reasoningEffort
    : Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
      : null;
  const normalizedEfforts = effortListRaw
    ? effortListRaw
        .map((option) => {
          const item = option as RawReasoningEffort;
          const effort =
            typeof item?.effort === "string"
              ? item.effort
              : typeof item?.reasoningEffort === "string"
                ? item.reasoningEffort
                : null;
          if (!effort) {
            return null;
          }
          return {
            effort,
            ...(typeof item.description === "string" ? { description: item.description } : {}),
          };
        })
        .filter((option): option is NonNullable<typeof option> => option !== null)
    : undefined;

  const reasoningEffort = normalizedEfforts
    ? (() => {
        const unique: typeof normalizedEfforts = [];
        const seen = new Set<string>();
        for (const option of normalizedEfforts) {
          if (seen.has(option.effort)) {
            continue;
          }
          seen.add(option.effort);
          unique.push(option);
        }
        return unique;
      })()
    : undefined;

  return {
    id,
    model,
    ...(typeof raw.displayName === "string" ? { displayName: raw.displayName } : {}),
    ...(typeof raw.hidden === "boolean" ? { hidden: raw.hidden } : {}),
    ...(typeof raw.defaultReasoningEffort === "string"
      ? { defaultReasoningEffort: raw.defaultReasoningEffort }
      : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof raw.upgrade === "string" ? { upgrade: raw.upgrade } : {}),
    ...(Array.isArray(raw.inputModalities)
      ? {
          inputModalities: raw.inputModalities.filter(
            (modality): modality is string => typeof modality === "string",
          ),
        }
      : {}),
    ...(typeof raw.supportsPersonality === "boolean"
      ? { supportsPersonality: raw.supportsPersonality }
      : {}),
    ...(typeof raw.isDefault === "boolean" ? { isDefault: raw.isDefault } : {}),
  };
}

export function applyFilters(
  items: ThreadListItem[],
  options: { q?: string; status?: string; archived?: string },
): ThreadListItem[] {
  const q = options.q?.trim().toLowerCase();
  const status = options.status?.trim();
  const archived = options.archived;

  return items.filter((item) => {
    if (q && !`${item.title} ${item.preview}`.toLowerCase().includes(q)) {
      return false;
    }
    if (status && item.status !== status) {
      return false;
    }
    if (archived === "true" && !item.archived) {
      return false;
    }
    if (archived === "false" && item.archived) {
      return false;
    }
    return true;
  });
}

export function kindFromMethod(method: GatewayEvent["name"]): GatewayEvent["kind"] {
  if (method.includes("requestApproval") || method.startsWith("tool/requestUserInput")) {
    return "approval";
  }
  if (method.startsWith("thread/")) return "thread";
  if (method.startsWith("turn/")) return "turn";
  if (method.startsWith("item/")) return "item";
  return "system";
}

export function approvalTypeFromMethod(method: string): ApprovalType | null {
  if (method === "item/commandExecution/requestApproval") {
    return "commandExecution";
  }
  if (method === "item/fileChange/requestApproval") {
    return "fileChange";
  }
  if (method === "tool/requestUserInput") {
    return "userInput";
  }
  return null;
}
