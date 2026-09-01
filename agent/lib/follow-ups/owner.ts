import type { SessionContext } from "eve/context";
import { z } from "zod";
import type { FollowUpOwner } from "@/db/services/follow-ups";
import { scopeFromPrincipal } from "@/lib/access-scope";

const linqThreadIdSchema = z.string().regex(/^linq:/u);

export function requireFollowUpOwner(
  context: Pick<SessionContext, "session">
): FollowUpOwner {
  const caller = context.session.auth.current;
  if (caller?.principalType !== "user") {
    throw new Error("An authenticated user is required.");
  }
  const linqThreadId = linqThreadIdSchema.safeParse(
    caller.attributes.linqThreadId
  );
  if (!linqThreadId.success) {
    throw new Error(
      "Follow-ups need an iMessage destination. Text this assistant first, then create the follow-up from that conversation."
    );
  }
  const phoneNumber = z.string().safeParse(caller.attributes.phoneNumber);
  const owner = {
    auth: caller,
    linqThreadId: linqThreadId.data,
    scope: scopeFromPrincipal(caller),
  };
  return phoneNumber.success
    ? { ...owner, phoneNumber: phoneNumber.data }
    : owner;
}

export function requireFollowUpScope(context: Pick<SessionContext, "session">) {
  const caller = context.session.auth.current;
  if (caller?.principalType !== "user") {
    throw new Error("An authenticated user is required.");
  }
  return scopeFromPrincipal(caller);
}
