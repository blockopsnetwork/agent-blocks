import Redis from 'ioredis';
import { AgentJob } from '../types';
import { IJobStore } from '../ports/IJobStore';
import { logger } from '../logger';

const KEY_PREFIX = 'blocks:job:';
const INDEX_KEY  = 'blocks:jobs';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — terminal jobs auto-expire

function toKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

// AgentJob has Date fields — JSON.parse gives strings, so we rehydrate them.
function deserialize(raw: string): AgentJob {
  const obj = JSON.parse(raw);
  obj.createdAt   = new Date(obj.createdAt);
  obj.lastEventAt = new Date(obj.lastEventAt);
  return obj as AgentJob;
}

export class RedisJobStore implements IJobStore {
  constructor(private readonly redis: Redis) {}

  async save(job: AgentJob): Promise<void> {
    const key = toKey(job.id);
    const payload = JSON.stringify(job);
    const pipeline = this.redis.pipeline();
    pipeline.set(key, payload, 'EX', TTL_SECONDS);
    pipeline.sadd(INDEX_KEY, job.id);
    await pipeline.exec();
  }

  async get(id: string): Promise<AgentJob | undefined> {
    const raw = await this.redis.get(toKey(id));
    return raw ? deserialize(raw) : undefined;
  }

  async list(): Promise<AgentJob[]> {
    const ids = await this.redis.smembers(INDEX_KEY);
    if (ids.length === 0) return [];

    const keys = ids.map(toKey);
    const values = await this.redis.mget(...keys);

    const jobs: AgentJob[] = [];
    const staleIds: string[] = [];

    values.forEach((raw, i) => {
      if (raw) {
        jobs.push(deserialize(raw));
      } else {
        // Key expired but still in index — clean up lazily
        staleIds.push(ids[i]);
      }
    });

    if (staleIds.length > 0) {
      this.redis.srem(INDEX_KEY, ...staleIds).catch(err =>
        logger.warn({ err, staleIds }, 'failed to prune stale job index entries'),
      );
    }

    return jobs;
  }

  async delete(id: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(toKey(id));
    pipeline.srem(INDEX_KEY, id);
    await pipeline.exec();
  }
}

export function createRedisClient(url?: string): Redis {
  const redisUrl = url ?? process.env.REDIS_URL ?? 'redis://localhost:6379';
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });
  redis.on('error', err => logger.error({ err }, 'Redis connection error'));
  redis.on('connect', () => logger.info({ redisUrl }, 'Redis connected'));
  return redis;
}
