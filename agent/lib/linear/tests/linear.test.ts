import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { linearAuthOptions } from "@/agent/lib/linear/client";
import {
  linearIssueFilter,
  listAssignedLinearIssues,
} from "@/agent/lib/linear/issues";
import { linearScopes, linearSubject, linearTokenParams } from "@/lib/linear";
import { toolContextFor } from "@/tests/helpers/tool-context";

const userId = "better-auth:user-123";

describe("Linear", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses a user-scoped connector with only read access", () => {
    expect(linearScopes).toEqual(["read"]);
    expect(linearTokenParams(userId)).toEqual({
      scopes: ["read"],
      subject: linearSubject(userId),
    });
    expect(linearSubject(userId)).toEqual({
      id: userId,
      issuer: "openinstinct",
      type: "user",
    });
    expect(linearAuthOptions.tokenParams).toEqual({ scopes: ["read"] });
    expect(linearAuthOptions.validate).toBe(true);
  });

  it("builds bounded due-date filters", () => {
    expect(linearIssueFilter({ date: "2026-09-02", mode: "on" })).toEqual({
      dueDate: { eq: "2026-09-02" },
    });
    expect(linearIssueFilter({ date: "2026-09-02", mode: "before" })).toEqual({
      dueDate: { lt: "2026-09-02" },
    });
    expect(linearIssueFilter({ mode: "any" })).toBeUndefined();
  });

  it("lists the viewer's assigned issues and omits completed work", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: {
          viewer: {
            assignedIssues: {
              nodes: [
                issue("ENG-12", "started", "In Progress"),
                issue("ENG-13", "completed", "Done"),
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
            id: "linear-user-1",
            name: "Gleidson",
          },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const context = authorizedContext();

    await expect(
      listAssignedLinearIssues(context, {
        due: { date: "2026-09-02", mode: "on" },
        includeCompleted: false,
        maxResults: 50,
      })
    ).resolves.toMatchObject({
      hasMore: false,
      issues: [{ identifier: "ENG-12", title: "Ship Linear support" }],
      viewer: { id: "linear-user-1", name: "Gleidson" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer linear-access-token",
      "Content-Type": "application/json",
    });
    const requestBody = z.string().parse(request?.body);
    expect(JSON.parse(requestBody)).toMatchObject({
      variables: {
        after: null,
        filter: { dueDate: { eq: "2026-09-02" } },
      },
    });
  });

  it("surfaces GraphQL failures without returning partial data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ errors: [{ message: "Invalid filter" }] })
        )
    );

    await expect(
      listAssignedLinearIssues(authorizedContext(), {
        due: { mode: "any" },
        includeCompleted: false,
        maxResults: 50,
      })
    ).rejects.toThrow("Linear API error: Invalid filter");
  });

  it("requests fresh authorization after Linear rejects the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 }))
    );
    const requireAuth = vi.fn<ToolContext["requireAuth"]>();
    const context = authorizedContext(requireAuth);

    await expect(
      listAssignedLinearIssues(context, {
        due: { mode: "any" },
        includeCompleted: false,
        maxResults: 50,
      })
    ).rejects.toThrow("status 401");
    expect(requireAuth).toHaveBeenCalledOnce();
  });
});

function authorizedContext(
  requireAuth = vi.fn<ToolContext["requireAuth"]>()
): ToolContext {
  const getToken = vi
    .fn<ToolContext["getToken"]>()
    .mockResolvedValue({ token: "linear-access-token" });
  return {
    ...toolContextFor(),
    getToken,
    requireAuth,
  } satisfies ToolContext;
}

function issue(identifier: string, stateType: string, stateName: string) {
  return {
    dueDate: "2026-09-02",
    identifier,
    priority: 2,
    state: { name: stateName, type: stateType },
    team: { key: "ENG", name: "Engineering" },
    title: "Ship Linear support",
    url: `https://linear.app/example/issue/${identifier}`,
  };
}
