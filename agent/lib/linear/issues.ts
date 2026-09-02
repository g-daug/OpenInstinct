import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { linearGraphQl } from "@/agent/lib/linear/client";

const maxPages = 5;

const issueSchema = z.object({
  dueDate: z.string().nullable(),
  identifier: z.string(),
  priority: z.number().int(),
  state: z.object({
    name: z.string(),
    type: z.string(),
  }),
  team: z.object({
    key: z.string(),
    name: z.string(),
  }),
  title: z.string(),
  url: z.url(),
});

const assignedIssuesPageSchema = z.object({
  viewer: z.object({
    assignedIssues: z.object({
      nodes: z.array(issueSchema),
      pageInfo: z.object({
        endCursor: z.string().nullable(),
        hasNextPage: z.boolean(),
      }),
    }),
    id: z.string(),
    name: z.string(),
  }),
});

const assignedIssuesVariablesSchema = z.object({
  after: z.string().nullable(),
  filter: z
    .object({
      dueDate: z.union([
        z.object({ eq: z.iso.date() }),
        z.object({ lt: z.iso.date() }),
      ]),
    })
    .optional(),
});

export const linearDueFilterSchema = z.discriminatedUnion("mode", [
  z.object({ date: z.iso.date(), mode: z.literal("on") }),
  z.object({ date: z.iso.date(), mode: z.literal("before") }),
  z.object({ mode: z.literal("any") }),
]);

export type LinearDueFilter = z.infer<typeof linearDueFilterSchema>;

const assignedIssuesQuery = `
  query AssignedIssues($after: String, $filter: IssueFilter) {
    viewer {
      id
      name
      assignedIssues(first: 100, after: $after, filter: $filter) {
        nodes {
          dueDate
          identifier
          priority
          state { name type }
          team { key name }
          title
          url
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

export async function listAssignedLinearIssues(
  ctx: ToolContext,
  options: {
    readonly due: LinearDueFilter;
    readonly includeCompleted: boolean;
    readonly maxResults: number;
  }
) {
  const issues: z.infer<typeof issueSchema>[] = [];
  let after: string | null = null;
  let viewer: { id: string; name: string } | undefined;
  let hasMore = false;

  for (let page = 0; page < maxPages; page += 1) {
    const data: z.infer<typeof assignedIssuesPageSchema> = await linearGraphQl(
      ctx,
      assignedIssuesQuery,
      {
        after,
        filter: linearIssueFilter(options.due),
      },
      assignedIssuesVariablesSchema,
      assignedIssuesPageSchema
    );
    viewer = { id: data.viewer.id, name: data.viewer.name };

    for (const issue of data.viewer.assignedIssues.nodes) {
      if (
        !options.includeCompleted &&
        ["completed", "canceled"].includes(issue.state.type)
      ) {
        continue;
      }
      issues.push(issue);
      if (issues.length === options.maxResults) {
        hasMore =
          data.viewer.assignedIssues.pageInfo.hasNextPage ||
          data.viewer.assignedIssues.nodes.at(-1)?.identifier !==
            issue.identifier;
        return { hasMore, issues, viewer };
      }
    }

    const pageInfo: z.infer<
      typeof assignedIssuesPageSchema
    >["viewer"]["assignedIssues"]["pageInfo"] =
      data.viewer.assignedIssues.pageInfo;
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) {
      return { hasMore: false, issues, viewer };
    }
    after = pageInfo.endCursor;
    hasMore = true;
  }

  return { hasMore, issues, viewer };
}

export function linearIssueFilter(due: LinearDueFilter) {
  switch (due.mode) {
    case "on":
      return { dueDate: { eq: due.date } };
    case "before":
      return { dueDate: { lt: due.date } };
    case "any":
      return undefined;
  }
}
