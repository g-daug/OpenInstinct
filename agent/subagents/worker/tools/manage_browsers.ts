import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ConflictError, NotFoundError } from "@onkernel/sdk";
import type {
  BrowserCreateResponse,
  BrowserRetrieveResponse,
  BrowserUpdateResponse,
} from "@onkernel/sdk/resources/browsers";
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  createBrowserSession,
  deleteBrowserSession,
  listBrowserSessions,
  withBrowserProfileWriteLock,
} from "@/db/services/browsers";
import { recordBrowserTraceDomains } from "@/db/services/browser-traces";
import { kernel } from "@/lib/kernel";
import { requireWorkerScope } from "@/agent/subagents/worker/lib/access";
import { requireOwnedBrowserSession } from "@/agent/subagents/worker/lib/owned-browser";
import {
  domainFromUrl,
  harvestBrowserTraceDomains,
} from "@/agent/subagents/worker/lib/trace/domains";

const browserTimeoutFloorSeconds = 15 * 60;
const profileLeaseRetryDelaysMs = [100, 250, 500, 1000, 2000, 4000];

const inputSchema = z.object({
  action: z.enum(["create", "update", "list", "get", "delete"]),
  save_changes: z.boolean().optional(),
  session_id: z.string().optional(),
  start_url: z.url().optional(),
  timeout_seconds: z
    .number()
    .int()
    .min(browserTimeoutFloorSeconds)
    .max(259_200)
    .optional(),
  viewport_width: z.number().int().min(1).optional(),
  viewport_height: z.number().int().min(1).optional(),
  status: z.enum(["active", "deleted", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

const manageBrowsers = defineTool({
  description:
    'Manage browser sessions backed by the workspace persistent profile. Create read-only browsers by default so tasks can run in parallel. Immediately before a login, replace that task browser with one created using save_changes: true, then delete it after authentication so the session is saved. Only one profile writer may be active. Use "list" or "get" to inspect sessions.',
  inputSchema,
  async execute(input, context) {
    const scope = await requireWorkerScope(context);
    const signal = context.abortSignal;

    switch (input.action) {
      case "create": {
        const create = async () => {
          const profile = await ensureUserProfile(scope, signal);
          if (input.save_changes) {
            const activeWriter = await findActiveProfileWriter(
              profile.id,
              signal
            );
            if (activeWriter) {
              throw new Error(
                `Browser session ${activeWriter.session_id} is already saving login state for this workspace. Retry after it finishes.`
              );
            }
          }
          const browser = await createBrowserWithProfileLeaseRecovery(
            profile,
            input,
            signal
          );
          try {
            await createBrowserSession(scope, {
              createdAt: browser.created_at,
              sessionId: browser.session_id,
              workerSessionId: context.session.id,
            });
          } catch (error) {
            await kernel.browsers
              .deleteByID(browser.session_id, { signal })
              .catch(() => undefined);
            throw error;
          }
          const startDomain = input.start_url
            ? domainFromUrl(input.start_url)
            : undefined;
          if (startDomain) {
            await recordBrowserTraceDomains(scope, context.session.id, [
              startDomain,
            ]).catch(() => undefined);
          }
          return lifecycleResult(browser);
        };
        return input.save_changes
          ? withBrowserProfileWriteLock(scope, create)
          : create();
      }
      case "list": {
        const records = await listBrowserSessions(scope);
        const includeDeleted = input.status !== "active";
        const browsers = await Promise.all(
          records.map(async ({ sessionId }) => {
            try {
              const browser = await kernel.browsers.retrieve(
                sessionId,
                { include_deleted: includeDeleted },
                { signal }
              );
              const value = browserDescriptor(browser);
              if (input.status === "deleted" && value.status !== "deleted") {
                return null;
              }
              if (input.status === "active" && value.status !== "active") {
                return null;
              }
              return value;
            } catch (error) {
              if (isNotFoundError(error)) {
                await deleteBrowserSession(scope, sessionId);
              }
              return null;
            }
          })
        );
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          has_more: false,
          items: browsers
            .filter((browser) => browser !== null)
            .slice(offset, offset + limit),
          next_offset: null,
        };
      }
      case "get": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        return browserDescriptor(
          await retrieveBrowser(scope, sessionId, signal)
        );
      }
      case "update": {
        const sessionId = requireSessionId(input.session_id);
        await requireOwnedBrowserSession(scope, sessionId);
        const viewport = browserViewport(input);
        const browser = viewport
          ? await kernel.browsers.update(sessionId, { viewport }, { signal })
          : await retrieveBrowser(scope, sessionId, signal);
        return lifecycleResult(browser);
      }
      case "delete": {
        const sessionId = requireSessionId(input.session_id);
        const record = await requireOwnedBrowserSession(scope, sessionId);
        await harvestBrowserTraceDomains(
          scope,
          record.workerSessionId ?? context.session.id,
          { createdAt: record.createdAt, sessionId: record.sessionId },
          signal
        );
        await kernel.browsers
          .deleteByID(sessionId, { signal })
          .catch((cause: unknown) => {
            if (!isNotFoundError(cause)) throw cause;
          });
        await deleteBrowserSession(scope, sessionId);
        return "Browser session deleted successfully";
      }
    }
  },
});

export default manageBrowsers;

function requireSessionId(sessionId: string | undefined) {
  if (!sessionId) throw new Error("A browser session ID is required.");
  return sessionId;
}

async function createBrowserWithProfileLeaseRecovery(
  initialProfile: Awaited<ReturnType<typeof ensureUserProfile>>,
  input: z.infer<typeof inputSchema>,
  signal?: AbortSignal
) {
  let profile = initialProfile;
  const create = () =>
    kernel.browsers.create(
      {
        profile: {
          id: profile.id,
          save_changes: input.save_changes ?? false,
        },
        start_url: input.start_url,
        stealth: true,
        telemetry: {
          browser: { page: { enabled: true } },
          enabled: true,
        },
        timeout_seconds: input.timeout_seconds ?? browserTimeoutFloorSeconds,
        viewport: browserViewport(input),
      },
      { signal }
    );

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await create();
    } catch (error) {
      if (!input.save_changes || !(error instanceof ConflictError)) {
        throw error;
      }

      const activeWriter = await findActiveProfileWriter(profile.id, signal);
      if (activeWriter) {
        throw new Error(
          `Browser session ${activeWriter.session_id} is already saving login state for this workspace. Retry after it finishes.`,
          { cause: error }
        );
      }

      const retryDelay = profileLeaseRetryDelaysMs[attempt];
      if (retryDelay === undefined) {
        profile = await rotateStaleProfile(profile, signal);
        try {
          return await create();
        } catch (recoveryError) {
          throw new Error(
            "The stale browser profile was preserved, but its replacement could not start. Retry the task once more.",
            { cause: recoveryError }
          );
        }
      }

      // Kernel removes a closed writer from the active-session list before its
      // profile snapshot has always released the write lease. Give that
      // invisible finalization window a bounded chance to finish.
      await delay(retryDelay, undefined, { signal });
    }
  }
}

async function rotateStaleProfile(
  profile: Awaited<ReturnType<typeof ensureUserProfile>>,
  signal?: AbortSignal
) {
  if (!profile.name) {
    throw new Error(
      "The stale browser profile has no recoverable name. Retry after the provider releases it."
    );
  }

  const originalName = profile.name;
  const recoverySuffix = createHash("sha256")
    .update(`stale-profile\0${profile.id}\0${Date.now().toString()}`)
    .digest("hex")
    .slice(0, 12);
  const preservedName = `${originalName.slice(0, 40)}-stale-${recoverySuffix}`;
  await kernel.profiles.update(profile.id, { name: preservedName }, { signal });

  try {
    return await kernel.profiles.create({ name: originalName }, { signal });
  } catch (error) {
    await kernel.profiles
      .update(profile.id, { name: originalName }, { signal })
      .catch(() => undefined);
    throw new Error(
      "The stale browser profile could not be replaced; its original name was restored.",
      { cause: error }
    );
  }
}

async function retrieveBrowser(
  scope: Awaited<ReturnType<typeof requireWorkerScope>>,
  sessionId: string,
  signal?: AbortSignal
) {
  try {
    return await kernel.browsers.retrieve(sessionId, {}, { signal });
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    await deleteBrowserSession(scope, sessionId);
    throw new Error(
      "Browser session no longer exists. Its stale record was removed; create a fresh browser instead of retrying this session ID.",
      { cause: error }
    );
  }
}

function isNotFoundError(cause: unknown) {
  return z.object({ status: z.literal(404) }).safeParse(cause).success;
}

function browserViewport(input: z.infer<typeof inputSchema>) {
  const height = input.viewport_height;
  const width = input.viewport_width;
  if (height === undefined && width === undefined) return undefined;
  if (height === undefined || width === undefined) {
    throw new Error("Viewport width and height must be provided together.");
  }
  return { height, width };
}

type KernelBrowser =
  | BrowserCreateResponse
  | BrowserRetrieveResponse
  | BrowserUpdateResponse;

function browserDescriptor(browser: KernelBrowser) {
  return {
    browser_live_view_url: browser.browser_live_view_url,
    session_id: browser.session_id,
    status: browser.deleted_at ? "deleted" : "active",
    viewport: browser.viewport ?? undefined,
  };
}

function lifecycleResult(browser: KernelBrowser) {
  const value = browserDescriptor(browser);
  return {
    browser: value,
    next_actions: [
      `Use execute_playwright_code with session_id "${value.session_id}" for deterministic browser automation.`,
      `Use computer_action with session_id "${value.session_id}" for visual browser control.`,
      `Use manage_browsers with action "delete" and session_id "${value.session_id}" when finished.`,
    ],
  };
}

export function kernelProfileNameForScope(scope: {
  readonly userId: string;
  readonly workspaceId: string;
}) {
  return `openinstinct-${createHash("sha256")
    .update(`kernel-profile\0${scope.workspaceId}\0${scope.userId}`)
    .digest("hex")
    .slice(0, 40)}`;
}

async function ensureUserProfile(
  scope: { readonly userId: string; readonly workspaceId: string },
  signal?: AbortSignal
) {
  const name = kernelProfileNameForScope(scope);
  try {
    return await kernel.profiles.retrieve(name, { signal });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }

  try {
    return await kernel.profiles.create({ name }, { signal });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return kernel.profiles.retrieve(name, { signal });
  }
}

async function findActiveProfileWriter(
  profileId: string | undefined,
  signal: AbortSignal | undefined
) {
  if (!profileId) return undefined;
  for await (const browser of kernel.browsers.list(
    { query: profileId, status: "active" },
    { signal }
  )) {
    if (browser.profile?.id === profileId && browser.profile_save_changes) {
      return browser;
    }
  }
  return undefined;
}
