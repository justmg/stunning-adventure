const Redis = require('ioredis');
require('dotenv').config();

// Redis client setup
const redis = new Redis(process.env.REDIS_URL || {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
});

// Key naming constants
const KEYS = {
  CALL: (streamSid) => `ec:call:${streamSid}`,
  CALL_CHUNKS: (streamSid) => `ec:call:${streamSid}:chunks`,
  CALL_INDEX: (userId) => `ec:call_index:${userId}`,
  RATE_LIMIT_USER: (userId) => `ec:ratelimit:user:${userId}`,
  RATE_LIMIT_PHONE: (phone) => `ec:ratelimit:phone:${phone}`,
  ALERT_LOCK: (callId) => `ec:lock:alert:${callId}`,
  SESSION: (sessionId) => `ec:session:${sessionId}`,
  PUBSUB_ALERTS: 'ec:pubsub:alerts'
};

// TTL constants (in seconds)
const TTL = {
  CALL: 60 * 60 * 2,        // 2 hours
  RATE_LIMIT: 60,           // 1 minute
  ALERT_LOCK: 60 * 5,       // 5 minutes
  SESSION: 60 * 60 * 24     // 24 hours
};

class RedisCallManager {
  /**
   * Initialize a new call state in Redis
   */
  async createCall(streamSid, { userId, callId, phone }) {
    const callKey = KEYS.CALL(streamSid);
    const indexKey = KEYS.CALL_INDEX(userId);
    
    await redis.hset(callKey, {
      userId,
      callId,
      phone,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      alertTriggered: 0,
      llmState: 'idle',
      partialTranscript: '',
      finalTranscript: ''
    });
    
    await redis.expire(callKey, TTL.CALL);
    await redis.sadd(indexKey, streamSid);
    
    console.log(`Redis: Created call state for ${streamSid}`);
    return true;
  }

  /**
   * Update partial transcript (interim STT results)
   */
  async updatePartialTranscript(streamSid, partialText) {
    const callKey = KEYS.CALL(streamSid);
    await redis.hset(callKey, {
      partialTranscript: partialText,
      lastActivity: Date.now()
    });
  }

  /**
   * Append to final transcript (final STT results)
   */
  async appendFinalTranscript(streamSid, finalText) {
    const callKey = KEYS.CALL(streamSid);
    const existing = await redis.hget(callKey, 'finalTranscript') || '';
    const updated = existing ? `${existing} ${finalText}` : finalText;
    
    await redis.hset(callKey, {
      finalTranscript: updated,
      lastActivity: Date.now()
    });
    
    return updated;
  }

  /**
   * Update LLM state (speaking, idle, processing)
   */
  async updateLLMState(streamSid, state) {
    const callKey = KEYS.CALL(streamSid);
    await redis.hset(callKey, {
      llmState: state,
      lastActivity: Date.now()
    });
  }

  /**
   * Mark alert as triggered
   */
  async markAlertTriggered(streamSid) {
    const callKey = KEYS.CALL(streamSid);
    await redis.hset(callKey, {
      alertTriggered: 1,
      lastActivity: Date.now()
    });
  }

  /**
   * Get full call state
   */
  async getCallState(streamSid) {
    const callKey = KEYS.CALL(streamSid);
    const data = await redis.hgetall(callKey);
    
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    
    // Convert numeric fields
    return {
      ...data,
      startedAt: parseInt(data.startedAt),
      lastActivity: parseInt(data.lastActivity),
      alertTriggered: parseInt(data.alertTriggered) === 1
    };
  }

  /**
   * Get all active calls for a user
   */
  async getUserActiveCalls(userId) {
    const indexKey = KEYS.CALL_INDEX(userId);
    const streamSids = await redis.smembers(indexKey);
    
    const calls = [];
    for (const streamSid of streamSids) {
      const callState = await this.getCallState(streamSid);
      if (callState) {
        calls.push({ streamSid, ...callState });
      } else {
        // Clean up stale reference
        await redis.srem(indexKey, streamSid);
      }
    }
    
    return calls;
  }

  /**
   * End call and cleanup Redis state
   */
  async endCall(streamSid) {
    const callState = await this.getCallState(streamSid);
    if (!callState) return null;
    
    // Remove from user index
    await redis.srem(KEYS.CALL_INDEX(callState.userId), streamSid);
    
    // Delete call state
    await redis.del(KEYS.CALL(streamSid));
    await redis.del(KEYS.CALL_CHUNKS(streamSid));
    
    console.log(`Redis: Cleaned up call state for ${streamSid}`);
    return callState;
  }

  /**
   * Store raw STT chunks (optional, for debugging)
   */
  async addSTTChunk(streamSid, chunk) {
    const chunksKey = KEYS.CALL_CHUNKS(streamSid);
    await redis.lpush(chunksKey, JSON.stringify({
      timestamp: Date.now(),
      data: chunk
    }));
    await redis.expire(chunksKey, TTL.CALL);
  }
}

class RedisRateLimiter {
  /**
   * Check and increment rate limit for user
   */
  async checkUserRateLimit(userId, maxCalls = 10, windowSeconds = 60) {
    const key = KEYS.RATE_LIMIT_USER(userId);
    const count = await redis.incr(key);
    
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    
    if (count > maxCalls) {
      throw new Error(`Rate limit exceeded: ${count}/${maxCalls} calls in ${windowSeconds}s`);
    }
    
    return { count, limit: maxCalls, remaining: maxCalls - count };
  }

  /**
   * Check and increment rate limit for phone number
   */
  async checkPhoneRateLimit(phone, maxCalls = 5, windowSeconds = 60) {
    const key = KEYS.RATE_LIMIT_PHONE(phone);
    const count = await redis.incr(key);
    
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    
    if (count > maxCalls) {
      throw new Error(`Phone rate limit exceeded: ${count}/${maxCalls} calls in ${windowSeconds}s`);
    }
    
    return { count, limit: maxCalls, remaining: maxCalls - count };
  }
}

class RedisAlertManager {
  /**
   * Acquire lock for alert processing to prevent duplicates
   */
  async acquireAlertLock(callId) {
    const key = KEYS.ALERT_LOCK(callId);
    const acquired = await redis.set(key, '1', 'NX', 'EX', TTL.ALERT_LOCK);
    return !!acquired;
  }

  /**
   * Release alert lock
   */
  async releaseAlertLock(callId) {
    const key = KEYS.ALERT_LOCK(callId);
    await redis.del(key);
  }

  /**
   * Publish alert event for other services
   */
  async publishAlert(alertData) {
    const event = {
      ...alertData,
      timestamp: Date.now()
    };
    
    await redis.publish(KEYS.PUBSUB_ALERTS, JSON.stringify(event));
    console.log('Redis: Published alert event', event);
  }

  /**
   * Subscribe to alert events
   */
  subscribeToAlerts(callback) {
    const subscriber = new Redis(process.env.REDIS_URL || {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD,
    });

    subscriber.subscribe(KEYS.PUBSUB_ALERTS);
    subscriber.on('message', (channel, message) => {
      if (channel === KEYS.PUBSUB_ALERTS) {
        try {
          const alertData = JSON.parse(message);
          callback(alertData);
        } catch (error) {
          console.error('Error parsing alert message:', error);
        }
      }
    });

    return subscriber;
  }
}

class RedisSessionManager {
  /**
   * Create web session
   */
  async createSession(sessionId, sessionData) {
    const key = KEYS.SESSION(sessionId);
    const data = {
      ...sessionData,
      createdAt: Date.now(),
      lastActivity: Date.now()
    };
    
    await redis.hset(key, data);
    await redis.expire(key, TTL.SESSION);
    return data;
  }

  /**
   * Get session data
   */
  async getSession(sessionId) {
    const key = KEYS.SESSION(sessionId);
    const data = await redis.hgetall(key);
    
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    
    // Update last activity
    await redis.hset(key, 'lastActivity', Date.now());
    await redis.expire(key, TTL.SESSION);
    
    return {
      ...data,
      createdAt: parseInt(data.createdAt),
      lastActivity: parseInt(data.lastActivity)
    };
  }

  /**
   * Delete session
   */
  async deleteSession(sessionId) {
    const key = KEYS.SESSION(sessionId);
    await redis.del(key);
  }
}

// Cleanup utility
class RedisCleanup {
  /**
   * Clean up stale call references
   */
  async cleanupStaleCalls() {
    const pattern = 'ec:call_index:*';
    const keys = await redis.keys(pattern);
    
    let cleaned = 0;
    for (const indexKey of keys) {
      const streamSids = await redis.smembers(indexKey);
      
      for (const streamSid of streamSids) {
        const callKey = KEYS.CALL(streamSid);
        const exists = await redis.exists(callKey);
        
        if (!exists) {
          await redis.srem(indexKey, streamSid);
          cleaned++;
        }
      }
    }
    
    console.log(`Redis: Cleaned up ${cleaned} stale call references`);
    return cleaned;
  }

  /**
   * Get Redis stats
   */
  async getStats() {
    const info = await redis.info('keyspace');
    const memory = await redis.info('memory');
    
    return {
      keyspace: info,
      memory: memory,
      activeCalls: await redis.keys('ec:call:*').then(keys => keys.length),
      activeUsers: await redis.keys('ec:call_index:*').then(keys => keys.length)
    };
  }
}

// Export instances
const callManager = new RedisCallManager();
const rateLimiter = new RedisRateLimiter();
const alertManager = new RedisAlertManager();
const sessionManager = new RedisSessionManager();
const cleanup = new RedisCleanup();

module.exports = {
  redis,
  callManager,
  rateLimiter,
  alertManager,
  sessionManager,
  cleanup,
  KEYS,
  TTL
};