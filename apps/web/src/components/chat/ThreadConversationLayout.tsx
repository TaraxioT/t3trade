import type { ComponentProps, ReactNode } from "react";

import { cn } from "~/lib/utils";

interface ThreadConversationLayoutProps extends ComponentProps<"div"> {
  market: ReactNode;
  companion: ReactNode;
}

/** Keep the graph outside both the message scroll and the measured composer overlay. */
export function ThreadConversationLayout({
  market,
  companion,
  children,
  className,
  ...props
}: ThreadConversationLayoutProps) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col",
        market && "trading-thread-workspace",
        className,
      )}
      {...props}
    >
      {companion}
      {market}
      <section
        aria-label="Conversation"
        data-thread-conversation="true"
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          market && "trading-thread-conversation trading-thread-surface",
        )}
      >
        {children}
      </section>
    </div>
  );
}
