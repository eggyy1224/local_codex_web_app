export type KnownSlashCommand = "plan" | "plan-mode" | "review" | "status";

export type ParsedSlashCommand =
  | {
      type: "none";
      text: string;
    }
  | {
      type: "known";
      command: KnownSlashCommand;
      args: string;
      text: string;
    }
  | {
      type: "unknown";
      command: string;
      args: string;
      text: string;
    };

export function parseSlashCommand(text: string): ParsedSlashCommand {
  const trimmed = text.trim();
  const normalized = trimmed.replace(/^／/, "/");

  // Compatibility alias: allow plain "status" to trigger /status.
  if (/^status$/i.test(normalized)) {
    return {
      type: "known",
      command: "status",
      args: "",
      text: normalized,
    };
  }

  if (!normalized.startsWith("/")) {
    return { type: "none", text: trimmed };
  }

  const match = normalized.match(/^\/([A-Za-z0-9-]+)(?:\s+(.*))?$/);
  if (!match) {
    return { type: "none", text: normalized };
  }

  const rawCommand = match[1]?.toLowerCase() ?? "";
  const args = (match[2] ?? "").trim();
  if (rawCommand === "plan" || rawCommand === "plan-mode" || rawCommand === "review" || rawCommand === "status") {
    return {
      type: "known",
      command: rawCommand,
      args,
      text: normalized,
    };
  }

  return {
    type: "unknown",
    command: rawCommand,
    args,
    text: normalized,
  };
}
