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
  if (!trimmed.startsWith("/")) {
    return { type: "none", text: trimmed };
  }

  const match = trimmed.match(/^\/([A-Za-z0-9-]+)(?:\s+(.*))?$/);
  if (!match) {
    return { type: "none", text: trimmed };
  }

  const rawCommand = match[1]?.toLowerCase() ?? "";
  const args = (match[2] ?? "").trim();
  if (rawCommand === "plan" || rawCommand === "plan-mode" || rawCommand === "review" || rawCommand === "status") {
    return {
      type: "known",
      command: rawCommand,
      args,
      text: trimmed,
    };
  }

  return {
    type: "unknown",
    command: rawCommand,
    args,
    text: trimmed,
  };
}
