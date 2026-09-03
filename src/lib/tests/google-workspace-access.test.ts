import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("shared Google Workspace access", () => {
  it("shares one dedicated subject only with the configured allowlist", async () => {
    vi.stubEnv("GOOGLE_SHARED_ADMIN_USER_ID", "better-auth:admin");
    vi.stubEnv(
      "GOOGLE_SHARED_ALLOWED_USER_IDS",
      "better-auth:member, better-auth:another-member"
    );
    vi.resetModules();
    const google = await import("@/lib/google-workspace");

    expect(google.sharedGoogleWorkspaceAccess("better-auth:admin")).toBe(
      "admin"
    );
    expect(google.sharedGoogleWorkspaceAccess("better-auth:member")).toBe(
      "member"
    );
    expect(google.sharedGoogleWorkspaceAccess("better-auth:outsider")).toBe(
      "denied"
    );
    expect(
      google.googleWorkspaceSubject("better-auth:member", "dedicated")
    ).toEqual({
      id: "shared-google-workspace",
      issuer: "openinstinct",
      type: "user",
    });
    expect(() =>
      google.googleWorkspaceSubject("better-auth:outsider", "dedicated")
    ).toThrow(/not allowed/u);
    expect(
      google.googleWorkspaceSubject("better-auth:outsider", "personal")
    ).toEqual({
      id: "better-auth:outsider",
      issuer: "openinstinct",
      type: "user",
    });
  });
});
