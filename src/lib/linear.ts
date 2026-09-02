import type { ConnectTokenParams, ConnectTokenSubject } from "@vercel/connect";

export const linearScopes = ["read"] as const;

export function linearSubject(userId: string): ConnectTokenSubject {
  return { id: userId, issuer: "openinstinct", type: "user" };
}

export function linearTokenParams(userId: string): ConnectTokenParams {
  return {
    scopes: [...linearScopes],
    subject: linearSubject(userId),
  };
}
