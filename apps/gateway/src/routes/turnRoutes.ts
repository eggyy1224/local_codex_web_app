import type { FastifyInstance } from "fastify";
import type {
  CompactThreadResponse,
  CreateReviewRequest,
  CreateReviewResponse,
  CreateTurnRequest,
  CreateTurnResponse,
  ForkThreadRequest,
  ForkThreadResponse,
  InterruptTurnRequest,
  InterruptTurnResponse,
  RollbackThreadRequest,
  RollbackThreadResponse,
  SteerTurnRequest,
  SteerTurnResponse,
  ThreadControlRequest,
  ThreadControlResponse,
} from "@lcwa/shared-types";
import type { GatewayAppServerPort } from "../appServerPort.js";
import type { GatewayDbPort } from "../db.js";
import {
  asRecord,
  isResumeNeeded,
  permissionModeToTurnStartParams,
  readString,
  type RawTurn,
} from "../gatewayHelpers.js";
import { ThreadContextResolver, normalizeProjectKey } from "../threadContext.js";
import { assertLocalImagePathsInsideRoot } from "../uploads.js";

type RawSkillMetadata = {
  name?: unknown;
  path?: unknown;
  enabled?: unknown;
};

type RawSkillsListEntry = {
  cwd?: unknown;
  skills?: RawSkillMetadata[];
};

type RawSkillsListResult = {
  data?: RawSkillsListEntry[];
};

type RawAppInfo = {
  id?: unknown;
  name?: unknown;
  isAccessible?: unknown;
  isEnabled?: unknown;
};

type RawAppListResult = {
  data?: RawAppInfo[];
  nextCursor?: string | null;
};

type RawCollaborationModeMask = {
  name?: unknown;
  mode?: unknown;
  model?: unknown;
  reasoning_effort?: unknown;
  developer_instructions?: unknown;
};

export type LastTurnInputCache = Map<
  string,
  {
    input: CreateTurnRequest["input"];
    options?: CreateTurnRequest["options"];
  }
>;

export type CollaborationModeSupportRef = { value: boolean | null };

export type TurnRoutesDeps = {
  appServer: GatewayAppServerPort;
  db: GatewayDbPort;
  threadContextResolver: ThreadContextResolver;
  activeTurnByThread: Map<string, string>;
  lastTurnInputByThread: LastTurnInputCache;
  collaborationModeListSupported: CollaborationModeSupportRef;
  uploadRoot: string;
};

function dedupeInputItemKey(inputItem: { type: string; name: string; path: string }): string {
  return `${inputItem.type}|${inputItem.name}|${inputItem.path}`;
}

function findSlashTokens(input: CreateTurnRequest["input"]): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const item of input) {
    if (item.type !== "text") {
      continue;
    }
    const matches = item.text.match(/\$[A-Za-z0-9._-]+/g);
    if (!matches) {
      continue;
    }
    for (const match of matches) {
      const token = match.slice(1);
      const normalized = token.toLowerCase();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      tokens.push(normalized);
    }
  }

  return tokens;
}

function readCollaborationModeMasks(raw: unknown): RawCollaborationModeMask[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is RawCollaborationModeMask => Boolean(asRecord(item)));
  }
  const record = asRecord(raw);
  if (!record) {
    return [];
  }
  const data = record.data;
  if (Array.isArray(data)) {
    return data.filter((item): item is RawCollaborationModeMask => Boolean(asRecord(item)));
  }
  const presets = record.collaborationModes;
  if (Array.isArray(presets)) {
    return presets.filter((item): item is RawCollaborationModeMask => Boolean(asRecord(item)));
  }
  return [];
}

function makeReadableModeError(mode: "plan" | "default", message: string): Error {
  const error = new Error(`collaboration mode "${mode}" unavailable: ${message}`) as Error & {
    statusCode?: number;
  };
  error.statusCode = 400;
  return error;
}

function isCollaborationModeListUnsupported(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unsupported method: collaborationmode/list") ||
    normalized.includes("unhandled method: collaborationmode/list") ||
    (normalized.includes("method not found") && normalized.includes("collaborationmode/list"))
  );
}

export function registerTurnRoutes(
  app: FastifyInstance,
  {
    appServer,
    db,
    threadContextResolver,
    activeTurnByThread,
    lastTurnInputByThread,
    collaborationModeListSupported,
    uploadRoot,
  }: TurnRoutesDeps,
): void {
  async function resolveCollaborationMode(
    mode: "plan" | "default",
    fallbackModel?: string,
  ): Promise<{
    mode: "plan" | "default";
    settings: {
      model: string;
      reasoning_effort: string | null;
      developer_instructions: string | null;
    };
  }> {
    if (collaborationModeListSupported.value === false) {
      throw makeReadableModeError(mode, "unsupported method: collaborationMode/list");
    }

    let rawResult: unknown;
    try {
      rawResult = await appServer.request("collaborationMode/list", {});
      collaborationModeListSupported.value = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isCollaborationModeListUnsupported(message)) {
        collaborationModeListSupported.value = false;
      }
      throw makeReadableModeError(mode, message);
    }

    const presets = readCollaborationModeMasks(rawResult);
    const preset =
      presets.find((entry) => readString(entry.mode) === mode) ??
      presets.find((entry) => readString(entry.name)?.toLowerCase() === mode);
    if (!preset) {
      throw makeReadableModeError(mode, "preset not found");
    }

    const model = readString(preset.model) ?? fallbackModel ?? null;
    if (!model) {
      throw makeReadableModeError(mode, "preset missing model");
    }

    const reasoningEffort = readString(preset.reasoning_effort);
    const developerInstructions =
      preset.developer_instructions === null
        ? null
        : readString(preset.developer_instructions);

    return {
      mode,
      settings: {
        model,
        reasoning_effort: reasoningEffort,
        developer_instructions: developerInstructions ?? null,
      },
    };
  }

  async function resolveCollaborationModeWithFallback(
    mode: "plan" | "default" | undefined,
    fallbackModel: string | undefined,
    warnings: string[],
  ): Promise<
    | {
        mode: "plan" | "default";
        settings: {
          model: string;
          reasoning_effort: string | null;
          developer_instructions: string | null;
        };
      }
    | undefined
  > {
    if (!mode) {
      return undefined;
    }

    try {
      return await resolveCollaborationMode(mode, fallbackModel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (mode === "plan" && isCollaborationModeListUnsupported(message)) {
        warnings.push("plan_mode_fallback");
        return undefined;
      }
      throw error;
    }
  }

  async function listEnabledSkills(
    cwd?: string,
  ): Promise<Map<string, { name: string; path: string }>> {
    const skillsByToken = new Map<string, { name: string; path: string }>();
    const params =
      cwd && cwd !== "unknown"
        ? {
            cwds: [cwd],
          }
        : {};
    const result = (await appServer.request("skills/list", params)) as RawSkillsListResult;

    for (const entry of result.data ?? []) {
      for (const skill of entry.skills ?? []) {
        const name = readString(skill.name);
        const path = readString(skill.path);
        const enabled = typeof skill.enabled === "boolean" ? skill.enabled : true;
        if (!name || !path || !enabled) {
          continue;
        }
        const token = name.toLowerCase();
        if (!skillsByToken.has(token)) {
          skillsByToken.set(token, { name, path });
        }
      }
    }

    return skillsByToken;
  }

  async function listAppsForMentions(
    threadId: string,
  ): Promise<Map<string, { id: string; name: string }>> {
    const appsByToken = new Map<string, { id: string; name: string }>();
    let cursor: string | null = null;

    for (let i = 0; i < 20; i += 1) {
      const result = (await appServer.request("app/list", {
        cursor,
        limit: 100,
        threadId,
        forceRefetch: false,
      })) as RawAppListResult;

      for (const appEntry of result.data ?? []) {
        const id = readString(appEntry.id);
        const name = readString(appEntry.name);
        const isAccessible = appEntry.isAccessible === true;
        const isEnabled = appEntry.isEnabled === true;
        if (!id || !name || !isAccessible || !isEnabled) {
          continue;
        }
        const token = id.toLowerCase();
        if (!appsByToken.has(token)) {
          appsByToken.set(token, { id, name });
        }
      }

      cursor = result.nextCursor ?? null;
      if (!cursor) {
        break;
      }
    }

    return appsByToken;
  }

  async function appendInjectedSkillAndMentionItems(
    threadId: string,
    input: CreateTurnRequest["input"],
    cwd?: string,
  ): Promise<CreateTurnRequest["input"]> {
    const tokens = findSlashTokens(input);
    if (tokens.length === 0) {
      return input;
    }

    const dedupeKeys = new Set<string>();
    for (const item of input) {
      if (item.type === "skill" || item.type === "mention") {
        dedupeKeys.add(dedupeInputItemKey(item));
      }
    }

    const [skillsResult, appsResult] = await Promise.allSettled([
      listEnabledSkills(cwd),
      listAppsForMentions(threadId),
    ]);

    const skillsByToken =
      skillsResult.status === "fulfilled"
        ? skillsResult.value
        : new Map<string, { name: string; path: string }>();
    const appsByToken =
      appsResult.status === "fulfilled"
        ? appsResult.value
        : new Map<string, { id: string; name: string }>();

    if (skillsResult.status === "rejected") {
      app.log.warn(
        { err: skillsResult.reason },
        "skills/list failed, skipping skill auto-injection",
      );
    }
    if (appsResult.status === "rejected") {
      app.log.warn(
        { err: appsResult.reason },
        "app/list failed, skipping app mention auto-injection",
      );
    }

    const additions: CreateTurnRequest["input"] = [];
    for (const token of tokens) {
      const skill = skillsByToken.get(token);
      if (skill) {
        const next = {
          type: "skill" as const,
          name: skill.name,
          path: skill.path,
        };
        const key = dedupeInputItemKey(next);
        if (!dedupeKeys.has(key)) {
          dedupeKeys.add(key);
          additions.push(next);
        }
        continue;
      }

      const appEntry = appsByToken.get(token);
      if (!appEntry) {
        continue;
      }
      const next = {
        type: "mention" as const,
        name: appEntry.name,
        path: `app://${appEntry.id}`,
      };
      const key = dedupeInputItemKey(next);
      if (!dedupeKeys.has(key)) {
        dedupeKeys.add(key);
        additions.push(next);
      }
    }

    if (additions.length === 0) {
      return input;
    }
    return [...input, ...additions];
  }

  app.post("/api/threads/:id/turns", async (request): Promise<CreateTurnResponse> => {
    const params = request.params as { id: string };
    const body = request.body as CreateTurnRequest;

    if (!Array.isArray(body?.input) || body.input.length === 0) {
      const error = new Error("input is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    assertLocalImagePathsInsideRoot(body.input, uploadRoot);

    const projected = db.getProjectedThread(params.id);
    const inferredCwd =
      body.options?.cwd ??
      (projected?.projectKey && projected.projectKey !== "unknown"
        ? projected.projectKey
        : undefined);
    const input = await appendInjectedSkillAndMentionItems(
      params.id,
      body.input,
      inferredCwd,
    );
    const warnings: string[] = [];
    const collaborationMode = await resolveCollaborationModeWithFallback(
      body.options?.collaborationMode,
      body.options?.model,
      warnings,
    );

    lastTurnInputByThread.set(params.id, {
      input,
      options: body.options,
    });

    const startTurn = async (): Promise<{ turn?: RawTurn }> =>
      (await appServer.request("turn/start", {
        threadId: params.id,
        input,
        ...(body.options?.model ? { model: body.options.model } : {}),
        ...(body.options?.effort ? { effort: body.options.effort } : {}),
        ...(body.options?.cwd ? { cwd: body.options.cwd } : {}),
        ...(collaborationMode ? { collaborationMode } : {}),
        ...permissionModeToTurnStartParams(body.options?.permissionMode),
      })) as { turn?: RawTurn };

    let result: { turn?: RawTurn };
    try {
      result = await startTurn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isResumeNeeded(message)) {
        throw error;
      }

      await appServer.request("thread/resume", { threadId: params.id });
      result = await startTurn();
    }

    const turnId = result.turn?.id;
    if (!turnId) {
      throw new Error("turn/start response missing turn.id");
    }

    activeTurnByThread.set(params.id, turnId);
    if (body.options?.cwd) {
      db.updateThreadProjectKey(params.id, normalizeProjectKey(body.options.cwd));
      threadContextResolver.invalidate(params.id);
    }

    return warnings.length > 0 ? { turnId, warnings } : { turnId };
  });

  app.post("/api/threads/:id/review", async (request): Promise<CreateReviewResponse> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as CreateReviewRequest;
    const instructions =
      typeof body.instructions === "string" ? body.instructions.trim() : "";

    const target =
      instructions.length > 0
        ? {
            type: "custom" as const,
            instructions,
          }
        : body.target ?? { type: "uncommittedChanges" as const };
    const delivery = body.delivery ?? "inline";

    const startReview = async (): Promise<{
      turn?: RawTurn;
      reviewThreadId?: unknown;
    }> =>
      (await appServer.request("review/start", {
        threadId: params.id,
        delivery,
        target,
      })) as {
        turn?: RawTurn;
        reviewThreadId?: unknown;
      };

    let result: {
      turn?: RawTurn;
      reviewThreadId?: unknown;
    };
    try {
      result = await startReview();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isResumeNeeded(message)) {
        throw error;
      }
      await appServer.request("thread/resume", { threadId: params.id });
      result = await startReview();
    }

    const turnId = result.turn?.id;
    if (!turnId) {
      throw new Error("review/start response missing turn.id");
    }

    return {
      turnId,
      reviewThreadId: readString(result.reviewThreadId) ?? params.id,
    };
  });

  app.post("/api/threads/:id/steer", async (request): Promise<SteerTurnResponse> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as SteerTurnRequest;

    if (typeof body.expectedTurnId !== "string" || body.expectedTurnId.length === 0) {
      const err = new Error("expectedTurnId required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }
    if (!Array.isArray(body.input) || body.input.length === 0) {
      const err = new Error("input is required") as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    }

    assertLocalImagePathsInsideRoot(body.input, uploadRoot);

    const result = (await appServer.request("turn/steer", {
      threadId: params.id,
      expectedTurnId: body.expectedTurnId,
      input: body.input,
    })) as { turnId?: unknown };

    const turnId = readString(result.turnId);
    if (!turnId) {
      const err = new Error("turn/steer response missing turnId") as Error & {
        statusCode?: number;
      };
      err.statusCode = 502;
      throw err;
    }
    return { turnId };
  });

  app.post(
    "/api/threads/:id/interrupt",
    async (request): Promise<InterruptTurnResponse> => {
      const params = request.params as { id: string };
      const body = (request.body ?? {}) as InterruptTurnRequest;

      if (typeof body.turnId !== "string" || body.turnId.length === 0) {
        const err = new Error("turnId required") as Error & { statusCode?: number };
        err.statusCode = 400;
        throw err;
      }

      await appServer.request("turn/interrupt", {
        threadId: params.id,
        turnId: body.turnId,
      });

      return { ok: true };
    },
  );

  app.post(
    "/api/threads/:id/compact",
    async (request): Promise<CompactThreadResponse> => {
      const params = request.params as { id: string };

      // Gate 1: never compact while a turn is in flight. app-server rejects
      // this anyway, but doing the check up front gives the user a readable
      // 409 instead of a bare RPC error — and avoids touching codex at all.
      if (activeTurnByThread.has(params.id)) {
        const err = new Error("cannot compact while a turn is in progress") as Error & {
          statusCode?: number;
        };
        err.statusCode = 409;
        throw err;
      }

      try {
        await appServer.request("thread/compact/start", {
          threadId: params.id,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        // Gate 2: a thread that needs a resume to even accept compact is not
        // in a healthy state. Force-resuming + compacting here is exactly the
        // path that left threads stuck in systemError, so we refuse instead of
        // silently doing it. Surface a readable reason rather than a raw 5xx.
        if (isResumeNeeded(message)) {
          const err = new Error(
            "thread is not in a state that can be compacted (resume required); send a turn to load it first",
          ) as Error & { statusCode?: number };
          err.statusCode = 409;
          throw err;
        }

        // Any other app-server rejection (e.g. turn in progress detected on
        // the codex side, unsupported state): turn it into a readable message
        // instead of a bare 500.
        const err = new Error(`compact rejected by app-server: ${message}`) as Error & {
          statusCode?: number;
        };
        err.statusCode = 409;
        throw err;
      }

      return { ok: true };
    },
  );

  app.post("/api/threads/:id/fork", async (request): Promise<ForkThreadResponse> => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as ForkThreadRequest;

    const rpcParams: Record<string, unknown> = { threadId: params.id };
    if (typeof body.model === "string") {
      rpcParams.model = body.model;
    }
    if (body.serviceTier === "fast" || body.serviceTier === "flex" || body.serviceTier === null) {
      rpcParams.serviceTier = body.serviceTier;
    }
    if (typeof body.approvalPolicy === "string") {
      rpcParams.approvalPolicy = body.approvalPolicy;
    }
    if (typeof body.cwd === "string") {
      rpcParams.cwd = body.cwd;
    }

    const result = (await appServer.request("thread/fork", rpcParams)) as {
      thread?: { id?: unknown };
    };
    const threadId = readString(result.thread?.id);
    if (!threadId) {
      const err = new Error("thread/fork response missing thread.id") as Error & {
        statusCode?: number;
      };
      err.statusCode = 502;
      throw err;
    }
    return { threadId };
  });

  app.post(
    "/api/threads/:id/rollback",
    async (request): Promise<RollbackThreadResponse> => {
      const params = request.params as { id: string };
      const body = (request.body ?? {}) as RollbackThreadRequest;

      if (
        typeof body.numTurns !== "number" ||
        !Number.isFinite(body.numTurns) ||
        !Number.isInteger(body.numTurns) ||
        body.numTurns < 1
      ) {
        const err = new Error("numTurns must be an integer >= 1") as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        throw err;
      }

      const result = (await appServer.request("thread/rollback", {
        threadId: params.id,
        numTurns: body.numTurns,
      })) as { thread?: { id?: unknown } };
      const threadId = readString(result.thread?.id);
      if (!threadId) {
        const err = new Error("thread/rollback response missing thread.id") as Error & {
          statusCode?: number;
        };
        err.statusCode = 502;
        throw err;
      }
      return { threadId };
    },
  );

  app.post("/api/threads/:id/control", async (request): Promise<ThreadControlResponse> => {
    const params = request.params as { id: string };
    const body = request.body as ThreadControlRequest;

    if (body.action !== "stop" && body.action !== "retry" && body.action !== "cancel") {
      const error = new Error("invalid action") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }

    if (body.action === "retry") {
      const previous = lastTurnInputByThread.get(params.id);
      if (!previous) {
        const error = new Error("no previous turn input") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }

      const collaborationMode = await resolveCollaborationModeWithFallback(
        previous.options?.collaborationMode,
        previous.options?.model,
        [],
      );

      const startTurn = async (): Promise<{ turn?: RawTurn }> =>
        (await appServer.request("turn/start", {
          threadId: params.id,
          input: previous.input,
          ...(previous.options?.model ? { model: previous.options.model } : {}),
          ...(previous.options?.effort ? { effort: previous.options.effort } : {}),
          ...(previous.options?.cwd ? { cwd: previous.options.cwd } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
          ...permissionModeToTurnStartParams(previous.options?.permissionMode),
        })) as { turn?: RawTurn };

      let result: { turn?: RawTurn };
      try {
        result = await startTurn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isResumeNeeded(message)) {
          throw error;
        }
        await appServer.request("thread/resume", { threadId: params.id });
        result = await startTurn();
      }

      const turnId = result.turn?.id;
      if (!turnId) {
        throw new Error("turn/start response missing turn.id");
      }

      activeTurnByThread.set(params.id, turnId);
      if (previous.options?.cwd) {
        db.updateThreadProjectKey(params.id, normalizeProjectKey(previous.options.cwd));
        threadContextResolver.invalidate(params.id);
      }
      return { ok: true, appliedToTurnId: turnId };
    }

    const activeTurnId = activeTurnByThread.get(params.id);
    if (!activeTurnId) {
      return { ok: true };
    }

    const interruptTurn = async (): Promise<void> => {
      await appServer.request("turn/interrupt", {
        threadId: params.id,
        turnId: activeTurnId,
      });
    };

    try {
      await interruptTurn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isResumeNeeded(message)) {
        throw error;
      }
      await appServer.request("thread/resume", { threadId: params.id });
      await interruptTurn();
    }

    if (activeTurnByThread.get(params.id) === activeTurnId) {
      activeTurnByThread.delete(params.id);
    }

    return { ok: true, appliedToTurnId: activeTurnId };
  });
}
