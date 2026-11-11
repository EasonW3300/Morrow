import type { ReactNode } from "react";

export type BadgeTone = "ok" | "run" | "warn" | "error" | "idle" | "dim" | "muted";

export function Badge({
  tone,
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return <span className={["badge", tone ? `tone-${tone}` : "", className ?? ""].filter(Boolean).join(" ")}>{children}</span>;
}
