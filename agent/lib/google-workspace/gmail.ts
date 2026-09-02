import { createHash } from "node:crypto";
import { auth, gmail, type gmail_v1 } from "@googleapis/gmail";
import { getToken } from "@vercel/connect";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { env } from "@/env";
import { googleWorkspaceTokenParams } from "@/lib/google-workspace";
import { withGoogleAuth } from "./client";

type GmailMessage = gmail_v1.Schema$Message;
type GmailPart = gmail_v1.Schema$MessagePart;

export const GMAIL_UPDATE_ACTIONS = [
  "archive",
  "move_to_inbox",
  "mark_read",
  "mark_unread",
  "star",
  "unstar",
] as const;

export type GmailUpdateAction = (typeof GMAIL_UPDATE_ACTIONS)[number];

export const gmailSendSchema = z.object({
  bcc: z.array(z.email()).max(20).default([]),
  body: z.string().min(1).max(100_000),
  cc: z.array(z.email()).max(20).default([]),
  inReplyTo: z.string().max(998).optional(),
  subject: z.string().min(1).max(998),
  threadId: z.string().max(200).optional(),
  to: z.array(z.email()).min(1).max(20),
});

export async function searchGmail(
  ctx: ToolContext,
  query: string,
  maxResults: number
) {
  return withGmail(ctx, async (client) => {
    const listed = await client.users.messages.list(
      { maxResults, q: query, userId: "me" },
      { signal: ctx.abortSignal }
    );
    const messages = await Promise.all(
      (listed.data.messages ?? []).flatMap(({ id }) =>
        id
          ? [
              client.users.messages.get(
                {
                  format: "metadata",
                  id,
                  metadataHeaders: [
                    "From",
                    "To",
                    "Subject",
                    "Date",
                    "Message-ID",
                  ],
                  userId: "me",
                },
                { signal: ctx.abortSignal }
              ),
            ]
          : []
      )
    );
    return messages.map(({ data }) => minimizeMessage(data));
  });
}

export async function readGmailThread(ctx: ToolContext, threadId: string) {
  return withGmail(ctx, async (client) => {
    const { data: thread } = await client.users.threads.get(
      { format: "full", id: threadId, userId: "me" },
      { signal: ctx.abortSignal }
    );
    return minimizeThread(thread, threadId);
  });
}

export async function readGmailThreadForUser(userId: string, threadId: string) {
  const token = await getToken(
    env.GOOGLE_CONNECTOR_UID,
    googleWorkspaceTokenParams(userId)
  );
  const authClient = new auth.OAuth2();
  authClient.setCredentials({ access_token: token });
  const client = gmail({ auth: authClient, version: "v1" });
  const { data: thread } = await client.users.threads.get({
    format: "full",
    id: threadId,
    userId: "me",
  });
  return minimizeThread(thread, threadId);
}

export async function updateGmail(
  ctx: ToolContext,
  messageIds: string[],
  action: GmailUpdateAction
) {
  const ids = [...new Set(messageIds)];
  await withGmail(ctx, async (client) =>
    client.users.messages.batchModify(
      {
        requestBody: { ids, ...gmailUpdateLabels(action) },
        userId: "me",
      },
      { signal: ctx.abortSignal }
    )
  );
  return { action, updatedCount: ids.length };
}

export async function sendGmail(
  ctx: ToolContext,
  payload: z.infer<typeof gmailSendSchema>
) {
  const stableId = createHash("sha256")
    .update(`${ctx.session.id}:${ctx.callId}`)
    .digest("hex")
    .slice(0, 48);
  const headers = [
    `To: ${payload.to.map(safeHeader).join(", ")}`,
    ...(payload.cc.length
      ? [`Cc: ${payload.cc.map(safeHeader).join(", ")}`]
      : []),
    ...(payload.bcc.length
      ? [`Bcc: ${payload.bcc.map(safeHeader).join(", ")}`]
      : []),
    `Subject: ${safeHeader(payload.subject)}`,
    `Message-ID: <openinstinct-${stableId}@local>`,
    ...(payload.inReplyTo
      ? [
          `In-Reply-To: ${safeHeader(payload.inReplyTo)}`,
          `References: ${safeHeader(payload.inReplyTo)}`,
        ]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  const raw = Buffer.from(
    `${headers.join("\r\n")}\r\n\r\n${payload.body}`,
    "utf8"
  ).toString("base64url");
  return withGmail(ctx, async (client) => {
    const requestBody = payload.threadId
      ? { raw, threadId: payload.threadId }
      : { raw };
    const { data } = await client.users.messages.send(
      {
        requestBody,
        userId: "me",
      },
      { signal: ctx.abortSignal }
    );
    return data;
  });
}

export function findReplyAfterSentMessage(
  thread: {
    readonly messages: readonly {
      readonly date: string | null;
      readonly body: string;
      readonly from: string | null;
      readonly id: string | null;
      readonly internalDate: string | null;
      readonly labels: readonly string[];
      readonly snippet: string;
      readonly subject: string | null;
    }[];
  },
  sentMessageId: string,
  sentAt: string
) {
  const baselineIndex = thread.messages.findIndex(
    (message) => message.id === sentMessageId
  );
  const sentAtMs = new Date(sentAt).getTime();
  const candidates =
    baselineIndex >= 0
      ? thread.messages.slice(baselineIndex + 1)
      : thread.messages.filter((message) => {
          const internalDate = Number(message.internalDate);
          return Number.isFinite(internalDate) && internalDate > sentAtMs;
        });
  const reply = candidates.findLast(
    (message) =>
      message.id !== null && !message.labels.some((label) => label === "SENT")
  );
  return reply?.id
    ? {
        date: reply.date,
        excerpt: replyExcerpt(reply.body || reply.snippet),
        from: reply.from,
        messageId: reply.id,
        subject: reply.subject,
      }
    : undefined;
}

export function replyExcerpt(value: string, maxLength = 500) {
  const unquoted = value
    .replace(/\r\n?/gu, "\n")
    .split(
      /\n(?:On .+ wrote:|From:\s.+|-----Original Message-----)(?:\n|$)/iu,
      1
    )[0]
    ?.split("\n")
    .filter((line) => !/^\s*>/u.test(line))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!unquoted) return "Reply text was unavailable.";
  if (unquoted.length <= maxLength) return unquoted;
  return `${unquoted.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function gmailUpdateLabels(action: GmailUpdateAction) {
  switch (action) {
    case "archive":
      return { addLabelIds: [], removeLabelIds: ["INBOX"] };
    case "move_to_inbox":
      return { addLabelIds: ["INBOX"], removeLabelIds: [] };
    case "mark_read":
      return { addLabelIds: [], removeLabelIds: ["UNREAD"] };
    case "mark_unread":
      return { addLabelIds: ["UNREAD"], removeLabelIds: [] };
    case "star":
      return { addLabelIds: ["STARRED"], removeLabelIds: [] };
    case "unstar":
      return { addLabelIds: [], removeLabelIds: ["STARRED"] };
  }
}

function header(part: GmailPart | undefined, name: string) {
  return (
    part?.headers?.find(
      (item) => item.name?.toLowerCase() === name.toLowerCase()
    )?.value ?? null
  );
}

function plainText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text) return text;
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBase64Url(part.body.data)
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ");
  }
  return "";
}

function minimizeMessage(message: GmailMessage) {
  return {
    date: header(message.payload, "Date"),
    from: header(message.payload, "From"),
    id: message.id ?? null,
    internalDate: message.internalDate ?? null,
    labels: message.labelIds ?? [],
    messageId: header(message.payload, "Message-ID"),
    snippet: redactGoogleText(message.snippet ?? "", 500),
    subject: header(message.payload, "Subject"),
    threadId: message.threadId ?? null,
    to: header(message.payload, "To"),
  };
}

function minimizeThread(thread: gmail_v1.Schema$Thread, fallbackId: string) {
  return {
    id: thread.id ?? fallbackId,
    messages: (thread.messages ?? []).slice(-20).map((message) => ({
      ...minimizeMessage(message),
      attachments: collectAttachments(message.payload),
      body: redactGoogleText(plainText(message.payload)),
    })),
  };
}

function collectAttachments(part: GmailPart | undefined): {
  attachmentId: string;
  filename: string;
  size: number;
}[] {
  if (!part) return [];
  const own =
    part.filename && part.body?.attachmentId
      ? [
          {
            attachmentId: part.body.attachmentId,
            filename: part.filename,
            size: part.body.size ?? 0,
          },
        ]
      : [];
  const nested = (part.parts ?? []).flatMap((child) => {
    return collectAttachments(child);
  });
  return [...own, ...nested];
}

function safeHeader(value: string) {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function withGmail<T>(
  ctx: ToolContext,
  execute: (client: ReturnType<typeof gmail>) => Promise<T>
) {
  return withGoogleAuth(ctx, (auth) => execute(gmail({ auth, version: "v1" })));
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

const secretPatterns: readonly (readonly [RegExp, string])[] = [
  [/\b\d{6}\b/gu, "[six-digit code redacted]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/gu, "[api key redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[github token redacted]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[aws key redacted]"],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/gu, "[google api key redacted]"],
  [/\b(?:bearer\s+)[A-Za-z0-9._~+/-]+=*\b/giu, "Bearer [token redacted]"],
  [
    /\b(password|passcode|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1=[credential redacted]",
  ],
  [/\b(?:\d[ -]*?){13,19}\b/gu, "[payment number redacted]"],
];

function redactGoogleText(value: string, maxLength = 12_000) {
  let redacted = value.slice(0, maxLength);
  for (const [pattern, replacement] of secretPatterns) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}
