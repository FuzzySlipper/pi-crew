// pi-core test helpers — exportable fakes for downstream test suites.
//
// These are the co-located test implementations of pi-core interfaces
// that other packages (pi-profiles, pi-memory, pi-channels, etc.) can
// import from `@pi-crew/core` to test their own logic in isolation.
//
//   import { InMemoryRepository, FakeEventBus, FakeLogger, FakeChannelProvider }
//     from "@pi-crew/core";
//

export { InMemoryRepository } from "./in-memory-repository.js";
export { FakeEventBus } from "./fake-event-bus.js";
export { FakeLogger, type LogEntry } from "./fake-logger.js";
export { FakeChannelProvider } from "./fake-channel-provider.js";
