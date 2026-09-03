import type { ConnectTokenParams, ConnectTokenSubject } from "@vercel/connect";
import { env } from "@/env";

export const GOOGLE_ACCOUNT_MODES = ["dedicated", "personal"] as const;
export type GoogleAccountMode = (typeof GOOGLE_ACCOUNT_MODES)[number];

export function parseGoogleAccountMode(value: string): GoogleAccountMode {
  if (value === "dedicated" || value === "personal") return value;
  throw new Error(`Unsupported Google account mode: ${value}`);
}

export const googleWorkspaceScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/contacts.readonly",
] as const;

export function googleWorkspaceSubject(
  userId: string,
  account: GoogleAccountMode = "dedicated"
): ConnectTokenSubject {
  if (
    account === "dedicated" &&
    sharedGoogleWorkspaceEnabled() &&
    sharedGoogleWorkspaceAccess(userId) === "denied"
  ) {
    throw new Error(
      "This user is not allowed to use the dedicated Lever Google account."
    );
  }
  return {
    id:
      account === "dedicated" && sharedGoogleWorkspaceEnabled()
        ? "shared-google-workspace"
        : userId,
    issuer: "openinstinct",
    type: "user",
  };
}

export function googleWorkspaceTokenParams(
  userId: string,
  account: GoogleAccountMode = "dedicated"
): ConnectTokenParams {
  return {
    scopes: [...googleWorkspaceScopes],
    subject: googleWorkspaceSubject(userId, account),
  };
}

export function sharedGoogleWorkspaceAccess(userId: string) {
  const adminUserId = env.GOOGLE_SHARED_ADMIN_USER_ID;
  if (!adminUserId) return "admin" as const;
  if (userId === adminUserId) return "admin" as const;
  const allowed = new Set(
    (env.GOOGLE_SHARED_ALLOWED_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return allowed.has(userId) ? ("member" as const) : ("denied" as const);
}

export function sharedGoogleWorkspaceEnabled() {
  return env.GOOGLE_SHARED_ADMIN_USER_ID !== undefined;
}
