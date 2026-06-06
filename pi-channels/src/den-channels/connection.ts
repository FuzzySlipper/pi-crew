/**
 * Den Channels Gateway connection layer.
 *
 * Re-exports from the split connection modules:
 * - {@link connection-types} — wire types, events, interface, config
 * - {@link connection-websocket} — real WebSocket with auth/reconnect/heartbeat
 * - {@link connection-simulated} — in-memory fake for unit tests
 *
 * @module pi-channels/den-channels/connection
 */

export type {
  DenInboundMessage,
  DenSender,
  DenContent,
  DenOutboundPayload,
  DenBreadcrumbPayload,
  DenSendResult,
  DenConnectionEvents,
  DenConnection,
  DenConnectionConfig,
  DenHttpConnectionConfig,
  CursorStore,
} from "./connection-types.js";

export { DenWebSocketConnection } from "./connection-websocket.js";
export { SimulatedDenConnection } from "./connection-simulated.js";
export { DenHttpDirectAgentConnection } from "./connection-http.js";
