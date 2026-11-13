import { RedisClientType } from "redis";

export interface CancellationStore {
  requestCancel(agentRunId: string): Promise<void>;
  clear(agentRunId: string): Promise<void>;
  isCancellationRequested(agentRunId: string): Promise<boolean>;
}

type CancellationRedisClient = Pick<RedisClientType, "set" | "get" | "del">;

function keyFor(agentRunId: string): string {
  return `agent-run:${agentRunId}:cancel`;
}

export class RedisCancellationStore implements CancellationStore {
  constructor(
    private readonly client: CancellationRedisClient,
    private readonly ttlSeconds = 60 * 60
  ) {}

  async requestCancel(agentRunId: string): Promise<void> {
    await this.client.set(keyFor(agentRunId), "1", {
      expiration: { type: "EX", value: this.ttlSeconds }
    });
  }

  async clear(agentRunId: string): Promise<void> {
    await this.client.del(keyFor(agentRunId));
  }

  async isCancellationRequested(agentRunId: string): Promise<boolean> {
    return (await this.client.get(keyFor(agentRunId))) === "1";
  }
}

export class MemoryCancellationStore implements CancellationStore {
  private readonly cancelled = new Set<string>();

  async requestCancel(agentRunId: string): Promise<void> {
    this.cancelled.add(agentRunId);
  }

  async clear(agentRunId: string): Promise<void> {
    this.cancelled.delete(agentRunId);
  }

  async isCancellationRequested(agentRunId: string): Promise<boolean> {
    return this.cancelled.has(agentRunId);
  }
}
