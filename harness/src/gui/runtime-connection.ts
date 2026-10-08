import type { ApiClient } from '../api/client.ts';
import type { EventMessage } from '../api/protocol.ts';

/** Reconnect only the API transport. Calls are issued by their caller once; a lost response is never replayed. */
export class GuiRuntimeConnection {
  private api?: ApiClient;
  private pending?: Promise<ApiClient>;
  private connectedBefore = false;
  private readonly open: () => Promise<ApiClient>;
  private readonly initialStart: () => Promise<void>;
  private readonly event: (value: EventMessage | { runtimeConnection: 'lost' | 'connected' }) => void;
  constructor(open: () => Promise<ApiClient>, initialStart: () => Promise<void>,
    event: (value: EventMessage | { runtimeConnection: 'lost' | 'connected' }) => void) {
    this.open = open; this.initialStart = initialStart; this.event = event;
  }
  async get(): Promise<ApiClient> {
    if (this.api && !this.api.closed) return this.api;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      if (!this.connectedBefore) await this.initialStart();
      const api = await this.open();
      api.onClose(() => {
        if (this.api === api) { this.api = undefined; this.event({ runtimeConnection: 'lost' }); }
      });
      try { await api.subscribe(value => this.event(value)); }
      catch (error) { api.close(); throw error; }
      this.api = api;
      this.connectedBefore = true;
      this.event({ runtimeConnection: 'connected' });
      return api;
    })();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  close(): void { this.api?.close(); }
}
