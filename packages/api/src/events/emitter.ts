import { EventEmitter } from "events";
import type { DomainEvent } from "@utility-cis/shared";

class DomainEventEmitter extends EventEmitter {
  emitDomainEvent(event: DomainEvent): void {
    this.emit("domain-event", event);
    this.emit(event.type, event);
  }
}

export const domainEvents = new DomainEventEmitter();
