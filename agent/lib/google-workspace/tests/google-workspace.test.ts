import { describe, expect, it } from "vitest";
import { parseCalendarAvailability } from "@/agent/lib/google-workspace/calendar";
import { googleWorkspaceAuthOptions } from "@/agent/lib/google-workspace/client";
import {
  findReplyAfterSentMessage,
  gmailUpdateLabels,
} from "@/agent/lib/google-workspace/gmail";
import {
  googleWorkspaceWriteApproval,
  googleWorkspaceWriteApprovalForSession,
} from "@/agent/tools/google_workspace_write";
import {
  googleWorkspaceScopes,
  googleWorkspaceSubject,
  googleWorkspaceTokenParams,
} from "@/lib/google-workspace";

const userId = "better-auth:user-123";

describe("Google Workspace", () => {
  it("uses one explicit least-privilege scope set", () => {
    expect(googleWorkspaceScopes).not.toContain("*");
    expect(googleWorkspaceScopes).not.toContain("https://mail.google.com/");
    expect(googleWorkspaceTokenParams(userId)).toEqual({
      scopes: [...googleWorkspaceScopes],
      subject: googleWorkspaceSubject(userId),
    });
    expect(googleWorkspaceAuthOptions.tokenParams).toEqual({
      scopes: [...googleWorkspaceScopes],
    });
    expect(googleWorkspaceAuthOptions.validate).toBe(true);
  });

  it("uses a user-scoped connector subject", () => {
    expect(googleWorkspaceSubject(userId)).toEqual({
      id: userId,
      issuer: "openinstinct",
      type: "user",
    });
  });

  it("maps reversible Gmail actions and protects consequential writes", () => {
    expect(gmailUpdateLabels("archive")).toEqual({
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });
    expect(gmailUpdateLabels("mark_unread")).toEqual({
      addLabelIds: ["UNREAD"],
      removeLabelIds: [],
    });
    expect(googleWorkspaceWriteApproval("update_email")).toBe("not-applicable");
    expect(googleWorkspaceWriteApproval("send_email")).toBe("user-approval");
    expect(
      googleWorkspaceWriteApprovalForSession("send_email", {
        linqThreadId: "linq:dm:example",
      })
    ).toBe("not-applicable");
    expect(googleWorkspaceWriteApprovalForSession("send_email", {})).toBe(
      "user-approval"
    );
  });

  it("does not treat calendar API errors as availability", () => {
    expect(() =>
      parseCalendarAvailability({
        calendars: {
          "missing@example.com": {
            errors: [{ domain: "global", reason: "notFound" }],
          },
        },
      })
    ).toThrow(/missing@example\.com: notFound/u);
  });

  it("detects an inbound Gmail reply after the exact sent message", () => {
    const messages = [
      gmailMessage("sent-1", ["SENT"], "1725289200000"),
      gmailMessage("sent-follow-up", ["SENT"], "1725289260000"),
      gmailMessage("reply-1", ["INBOX", "UNREAD"], "1725289320000", {
        date: "Wed, 2 Sep 2026 10:02:00 -0500",
        from: "Gleidson <gleidson@example.com>",
        subject: "Re: Dinner tonight",
      }),
    ];
    expect(
      findReplyAfterSentMessage(
        { messages },
        "sent-1",
        "2026-09-02T15:00:00.000Z"
      )
    ).toEqual({
      date: "Wed, 2 Sep 2026 10:02:00 -0500",
      from: "Gleidson <gleidson@example.com>",
      messageId: "reply-1",
      subject: "Re: Dinner tonight",
    });
    expect(
      findReplyAfterSentMessage(
        { messages: messages.slice(0, 2) },
        "sent-1",
        "2026-09-02T15:00:00.000Z"
      )
    ).toBeUndefined();
  });
});

function gmailMessage(
  id: string,
  labels: string[],
  internalDate: string,
  headers: {
    readonly date?: string;
    readonly from?: string;
    readonly subject?: string;
  } = {}
) {
  return {
    date: headers.date ?? null,
    from: headers.from ?? null,
    id,
    internalDate,
    labels,
    subject: headers.subject ?? null,
  };
}
