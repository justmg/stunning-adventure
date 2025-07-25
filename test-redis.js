const { redis, callManager, rateLimiter, alertManager, cleanup } = require('./lib/redis');

async function testRedis() {
  try {
    console.log('Testing Redis connection...');
    
    // Test basic connection
    await redis.ping();
    console.log('✅ Redis connected successfully');
    
    // Test call management
    const testStreamSid = 'test_stream_123';
    const testUserId = 'user_123';
    const testCallId = 'call_456';
    
    console.log('\n📞 Testing call management...');
    
    // Create call
    await callManager.createCall(testStreamSid, {
      userId: testUserId,
      callId: testCallId,
      phone: '+1234567890'
    });
    console.log('✅ Call created');
    
    // Update partial transcript
    await callManager.updatePartialTranscript(testStreamSid, 'Hello, this is a test...');
    
    // Update final transcript
    await callManager.appendFinalTranscript(testStreamSid, 'Hello, this is a test call.');
    
    // Get call state
    const callState = await callManager.getCallState(testStreamSid);
    console.log('✅ Call state retrieved:', callState);
    
    // Test rate limiting
    console.log('\n🚦 Testing rate limiting...');
    const rateResult = await rateLimiter.checkUserRateLimit(testUserId, 5, 60);
    console.log('✅ Rate limit check:', rateResult);
    
    // Test alert lock
    console.log('\n🔒 Testing alert locking...');
    const lockAcquired = await alertManager.acquireAlertLock(testCallId);
    console.log('✅ Alert lock acquired:', lockAcquired);
    
    const lockAttempt2 = await alertManager.acquireAlertLock(testCallId);
    console.log('✅ Second lock attempt (should be false):', lockAttempt2);
    
    await alertManager.releaseAlertLock(testCallId);
    console.log('✅ Alert lock released');
    
    // Test user active calls
    const activeCalls = await callManager.getUserActiveCalls(testUserId);
    console.log('✅ Active calls for user:', activeCalls.length);
    
    // Cleanup
    await callManager.endCall(testStreamSid);
    console.log('✅ Call cleaned up');
    
    // Test stats
    const stats = await cleanup.getStats();
    console.log('\n📊 Redis stats:', {
      activeCalls: stats.activeCalls,
      activeUsers: stats.activeUsers
    });
    
    console.log('\n🎉 All Redis tests passed!');
    
  } catch (error) {
    console.error('❌ Redis test failed:', error);
  } finally {
    await redis.disconnect();
  }
}

testRedis();