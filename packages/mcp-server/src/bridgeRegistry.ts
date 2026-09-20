import { BridgeClient, discoverInstances } from "../../bridge-client/src/index.js";
import { OperatorError } from "../../protocol/src/errors.js";
import type { EmacsInstanceRecord } from "../../protocol/src/types.js";

export class BridgeRegistry {
  private readonly clients = new Map<string, BridgeClient>();

  discover(): Array<{ record: EmacsInstanceRecord; stale: boolean; process_alive: boolean }> {
    return discoverInstances();
  }

  findRecord(instanceId?: string): EmacsInstanceRecord {
    const live = this.discover().filter((item) => !item.stale);
    if (instanceId) {
      const hit = live.find((item) => item.record.instance_id === instanceId);
      if (!hit) throw new OperatorError("E_INSTANCE_NOT_FOUND", `No live Emacs instance named ${instanceId}.`);
      return hit.record;
    }
    if (live.length === 0) throw new OperatorError("E_INSTANCE_NOT_FOUND", "No live Emacs Operator bridge instance was discovered.");
    if (live.length > 1) {
      throw new OperatorError("E_INVALID_ARGUMENT", "Multiple Emacs instances are available; selector.instance_id is required.", {
        instance_ids: live.map((item) => item.record.instance_id)
      });
    }
    return live[0]!.record;
  }

  async client(instanceId: string): Promise<BridgeClient> {
    const record = this.findRecord(instanceId);
    const cached = this.clients.get(instanceId);
    if (cached && cached.record.pid === record.pid && cached.record.port === record.port) return cached;
    if (cached) cached.close();
    const client = new BridgeClient(record);
    await client.connectAndInitialize();
    this.clients.set(instanceId, client);
    return client;
  }

  async connect(record: EmacsInstanceRecord): Promise<{ client: BridgeClient; initialization: Record<string, unknown> }> {
    const cached = this.clients.get(record.instance_id);
    if (cached && cached.record.pid === record.pid && cached.record.port === record.port) {
      return { client: cached, initialization: await cached.request("instance.describe", {}) };
    }
    if (cached) cached.close();
    const client = new BridgeClient(record);
    const initialization = await client.connectAndInitialize();
    this.clients.set(record.instance_id, client);
    return { client, initialization };
  }

  closeAll(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
