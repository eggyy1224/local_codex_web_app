export type KnownSlashCommand = "plan" | "plan-mode" | "review" | "status";

export type SlashCommandCatalogItem = {
  command: KnownSlashCommand;
  title: string;
  description: string;
  usage: string;
};

export const SLASH_COMMAND_CATALOG: readonly SlashCommandCatalogItem[] = [
  {
    command: "plan",
    title: "/plan",
    description: "switch to plan mode and optionally send prompt",
    usage: "/plan [prompt]",
  },
  {
    command: "plan-mode",
    title: "/plan-mode",
    description: "toggle plan mode and optionally send prompt",
    usage: "/plan-mode [prompt]",
  },
  {
    command: "review",
    title: "/review",
    description: "run code review",
    usage: "/review [instructions]",
  },
  {
    command: "status",
    title: "/status",
    description: "show thread status banner",
    usage: "/status",
  },
] as const;

const KNOWN_COMMAND_SET = new Set<KnownSlashCommand>(
  SLASH_COMMAND_CATALOG.map((item) => item.command),
);

function normalizeCommandToken(token: string): string {
  return token.replace(/^／/, "/");
}

function firstTokenParts(input: string): {
  leadingWhitespace: string;
  token: string;
  rest: string;
} {
  const match = input.match(/^(\s*)(\S*)([\s\S]*)$/);
  if (!match) {
    return {
      leadingWhitespace: "",
      token: "",
      rest: "",
    };
  }
  return {
    leadingWhitespace: match[1] ?? "",
    token: match[2] ?? "",
    rest: match[3] ?? "",
  };
}

function isKnownSlashCommand(command: string): command is KnownSlashCommand {
  return KNOWN_COMMAND_SET.has(command as KnownSlashCommand);
}

export function getSlashSuggestions(input: string): SlashCommandCatalogItem[] {
  const trimmedStart = input.trimStart();
  if (!trimmedStart) {
    return [];
  }

  const token = trimmedStart.split(/\s+/, 1)[0] ?? "";
  const normalizedToken = normalizeCommandToken(token);
  if (!normalizedToken.startsWith("/")) {
    return [];
  }

  const query = normalizedToken.slice(1).toLowerCase();
  if (isKnownSlashCommand(query)) {
    return [];
  }

  return SLASH_COMMAND_CATALOG.filter((item) =>
    item.command.startsWith(query),
  );
}

export function applySlashSuggestion(
  input: string,
  command: KnownSlashCommand,
): string {
  const parts = firstTokenParts(input);
  const args = parts.rest.trimStart();
  const commandText = `/${command}`;
  if (!args) {
    return `${parts.leadingWhitespace}${commandText} `;
  }
  return `${parts.leadingWhitespace}${commandText} ${args}`;
}

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
  const normalized = normalizeCommandToken(trimmed);

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
  if (isKnownSlashCommand(rawCommand)) {
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
