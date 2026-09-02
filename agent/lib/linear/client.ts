import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { env } from "@/env";
import { linearScopes, linearSubject } from "@/lib/linear";

const linearApiUrl = "https://api.linear.app/graphql";

export const linearAuthOptions = {
  connector: env.LINEAR_CONNECTOR_UID,
  createSubject(principal) {
    if (principal.type !== "user") {
      throw new Error("Linear requires an authenticated OpenInstinct user.");
    }
    return linearSubject(principal.id);
  },
  tokenParams: { scopes: [...linearScopes] },
  validate: true,
} satisfies EveAuthorizationOptions;

const linearAuth = connect(linearAuthOptions);

const linearGraphQlErrorSchema = z.object({
  message: z.string(),
});

const linearGraphQlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(linearGraphQlErrorSchema).optional(),
});

export async function linearGraphQl<TVariables, TResponse>(
  ctx: ToolContext,
  query: string,
  variables: TVariables,
  variablesSchema: z.ZodType<TVariables>,
  responseSchema: z.ZodType<TResponse>
): Promise<TResponse> {
  const { token } = await ctx.getToken(linearAuth);
  const response = await fetch(linearApiUrl, {
    body: JSON.stringify({
      query,
      variables: variablesSchema.parse(variables),
    }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: ctx.abortSignal,
  });

  if (response.status === 401) {
    ctx.requireAuth(linearAuth);
  }
  if (!response.ok) {
    throw new Error(
      `Linear API request failed with status ${response.status.toString()}.`
    );
  }

  const envelope = linearGraphQlEnvelopeSchema.parse(await response.json());
  if (envelope.errors?.length) {
    throw new Error(
      `Linear API error: ${envelope.errors.map(({ message }) => message).join("; ")}`
    );
  }
  if (envelope.data === undefined) {
    throw new Error("Linear API returned no data.");
  }
  return responseSchema.parse(envelope.data);
}
