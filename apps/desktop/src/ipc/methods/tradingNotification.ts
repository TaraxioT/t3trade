/**
 * The one trading IPC method (final-form Phase 5): the renderer's alert feed
 * hands over `{title, body}` and main raises an Electron `Notification`.
 *
 * Main-process because that is where OS notification permission lives; the
 * renderer feature-detects the bridge method, so a web tab (no bridge) and an
 * older desktop build (bridge without the method) both skip silently.
 *
 * @module tradingNotification
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Notification } from "electron";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showTradingNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_TRADING_NOTIFICATION_CHANNEL,
  payload: Schema.Struct({
    title: Schema.String,
    body: Schema.String,
  }),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.tradingNotification.show")(function* ({ title, body }) {
    yield* Effect.sync(() => {
      // Unsupported (some Linux setups) is a silent no-op: the alert is
      // already in the feed, the notification is only the announcement.
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    });
  }),
});
