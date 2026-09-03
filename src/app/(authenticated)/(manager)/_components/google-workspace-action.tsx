"use client";

import { Button } from "@/components/ui/button";
import { api } from "@/trpc/client";

export function GoogleWorkspaceAction({
  account,
  canManage = true,
  state,
}: {
  readonly account: "dedicated" | "personal";
  readonly canManage?: boolean;
  readonly state?: "connected" | "disconnected" | "unavailable";
}) {
  const update = api.googleWorkspace.update.useMutation({
    onError: () => window.location.assign("/?google=unavailable"),
    onSuccess: ({ redirectTo }) => window.location.assign(redirectTo),
  });

  if (!state) {
    return <span className="type-caption text-muted-foreground">Loading…</span>;
  }
  if (state === "unavailable") {
    return (
      <span className="type-caption text-muted-foreground">Setup required</span>
    );
  }
  if (!canManage) {
    return (
      <span className="type-caption text-muted-foreground">
        {state === "connected" ? "Shared" : "Admin setup required"}
      </span>
    );
  }

  const action = state === "connected" ? "disconnect" : "connect";
  return (
    <Button
      disabled={update.isPending}
      onClick={() => update.mutate({ account, action })}
      size="sm"
      type="button"
      variant="outline"
    >
      {state === "connected" ? "Disconnect" : "Connect"}
    </Button>
  );
}
