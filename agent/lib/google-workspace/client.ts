import { auth } from "@googleapis/gmail";
import {
  getToken,
  NoValidTokenError,
  UserAuthorizationRequiredError,
} from "@vercel/connect";
import { connect, type EveAuthorizationOptions } from "@vercel/connect/eve";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { env } from "@/env";
import {
  type GoogleAccountMode,
  googleWorkspaceSubject,
  googleWorkspaceScopes,
  googleWorkspaceTokenParams,
  sharedGoogleWorkspaceAccess,
  sharedGoogleWorkspaceEnabled,
} from "@/lib/google-workspace";
import { scopeFromPrincipal } from "@/lib/access-scope";

export const dedicatedGoogleWorkspaceAuthOptions = {
  connector: env.GOOGLE_CONNECTOR_UID,
  createSubject(principal) {
    if (principal.type !== "user") {
      throw new Error(
        "Google Workspace requires an authenticated OpenInstinct user."
      );
    }
    return googleWorkspaceSubject(principal.id, "dedicated");
  },
  tokenParams: { scopes: [...googleWorkspaceScopes] },
  validate: true,
} satisfies EveAuthorizationOptions;

export const personalGoogleWorkspaceAuthOptions = {
  connector: env.GOOGLE_CONNECTOR_UID,
  createSubject(principal) {
    if (principal.type !== "user") {
      throw new Error(
        "Google Workspace requires an authenticated OpenInstinct user."
      );
    }
    return googleWorkspaceSubject(principal.id, "personal");
  },
  tokenParams: { scopes: [...googleWorkspaceScopes] },
  validate: true,
} satisfies EveAuthorizationOptions;

const dedicatedGoogleWorkspaceAuth = connect(
  dedicatedGoogleWorkspaceAuthOptions
);
const personalGoogleWorkspaceAuth = connect(personalGoogleWorkspaceAuthOptions);

export async function withGoogleAuth<T>(
  ctx: ToolContext,
  execute: (authClient: InstanceType<typeof auth.OAuth2>) => Promise<T>,
  account: GoogleAccountMode = "dedicated"
) {
  const caller = ctx.session.auth.current ?? ctx.session.auth.initiator;
  if (!caller) {
    throw new Error("Google Workspace requires an authenticated user.");
  }
  const userId = scopeFromPrincipal(caller).userId;
  const access = sharedGoogleWorkspaceAccess(userId);
  const connection =
    account === "dedicated"
      ? dedicatedGoogleWorkspaceAuth
      : personalGoogleWorkspaceAuth;
  let token: string;
  try {
    token = await getToken(
      env.GOOGLE_CONNECTOR_UID,
      googleWorkspaceTokenParams(userId, account)
    );
  } catch (error) {
    if (
      isAuthorizationRequired(error) &&
      account === "dedicated" &&
      sharedGoogleWorkspaceEnabled() &&
      access !== "admin"
    ) {
      throw new Error(
        "The dedicated Lever Google account must be connected by its administrator.",
        { cause: error }
      );
    }
    if (!isAuthorizationRequired(error)) throw error;
    token = (await ctx.getToken(connection)).token;
  }
  const authClient = new auth.OAuth2();
  authClient.setCredentials({ access_token: token });

  try {
    return await execute(authClient);
  } catch (error) {
    if (googleApiErrorStatus(error) === 401) {
      if (
        account === "dedicated" &&
        sharedGoogleWorkspaceEnabled() &&
        access !== "admin"
      ) {
        throw new Error(
          "The dedicated Lever Google account must be reconnected by its administrator.",
          { cause: error }
        );
      }
      ctx.requireAuth(connection);
    }
    throw error;
  }
}

function isAuthorizationRequired(cause: unknown) {
  return (
    cause instanceof UserAuthorizationRequiredError ||
    cause instanceof NoValidTokenError
  );
}

const googleApiErrorSchema = z.object({
  response: z.object({ status: z.number() }),
});

export function googleApiErrorStatus(cause: unknown) {
  const result = googleApiErrorSchema.safeParse(cause);
  return result.success ? result.data.response.status : undefined;
}
