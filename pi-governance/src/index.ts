// pi-governance — Human oversight: breadcrumbs, audit logging, output routing.
// Depends on: pi-core

import type { EventBus, GatewayEvent, Logger } from "@pi-crew/core";

export interface Breadcrumb {
  timestamp: string;
  event: string;
  summary: string;
}

export class GovernanceLayer {
  private readonly breadcrumbs: Breadcrumb[] = [];

  constructor(
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {
    this.eventBus.on("gateway.event", this.onEvent.bind(this));
  }

  private onEvent(payload: unknown): void {
    const event = payload as GatewayEvent;
    const breadcrumb: Breadcrumb = {
      timestamp: new Date().toISOString(),
      event: event.event,
      summary: JSON.stringify(event.payload).slice(0, 200),
    };
    this.breadcrumbs.push(breadcrumb);
    this.logger.debug("Breadcrumb recorded", { event: event.event });
  }

  getBreadcrumbs(): readonly Breadcrumb[] {
    return this.breadcrumbs;
  }
}
