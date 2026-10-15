/**
 * Automated Integration Test Suite for VibeRoom 2.0
 *
 * Verifies:
 * 1. Health & ICE config HTTP endpoints
 * 2. Unauthenticated guest rejection (HTTP /api/profile & WebSocket join_queue)
 * 3. Account signup/login, profile updates, and privilege/gender spoofing protection
 * 4. Mutual gender-preference matchmaking (authoritative PostgreSQL/server profile enforcement)
 * 5. Incomplete gender profile handling & Random Chat mode fallback
 * 6. Persistent user blocklist enforcement across sessions
 * 7. Session isolation (rejecting spoofed/stale sessionIds on signal & chat_message)
 * 8. Disconnect cleanup, private safety report recording, and self-service account deletion
 */

const assert = require('assert');
const WebSocket = require('ws');
const { createVibeRoomServer } = require('./server');

async function registerUser(baseUrl, { email, password, display_name, gender, match_preference }) {
  const signupRes = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, display_name })
  });
  assert.strictEqual(signupRes.status, 201, `Signup failed for ${email}`);
  const signupData = await signupRes.json();
  const token = signupData.session.access_token;
  const userId = signupData.session.user.id;

  if (gender !== undefined || match_preference !== undefined) {
    const profRes = await fetch(`${baseUrl}/api/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        display_name,
        gender: gender || null,
        match_preference: match_preference || 'anyone'
      })
    });
    assert.strictEqual(profRes.status, 200);
  }

  return { userId, token, email, display_name };
}

function createTestWsClient(wsUrl, token = null) {
  return new Promise((resolve, reject) => {
    const target = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl;
    const ws = new WebSocket(target);
    const inbox = [];
    const waiters = [];

    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].predicate(msg)) {
          const waiter = waiters.splice(i, 1)[0];
          clearTimeout(waiter.timer);
          waiter.resolve(msg);
          return;
        }
      }
      inbox.push(msg);
    });

    function waitFor(predicate, timeoutMs = 3000) {
      for (let i = 0; i < inbox.length; i++) {
        if (predicate(inbox[i])) {
          return Promise.resolve(inbox.splice(i, 1)[0]);
        }
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          rej(new Error('Timed out waiting for expected WebSocket message'));
        }, timeoutMs);
        waiters.push({ predicate, resolve: res, timer });
      });
    }

    function send(payload) {
      ws.send(JSON.stringify(payload));
    }

    ws.once('open', async () => {
      try {
        const connectedMsg = await waitFor(m => m.type === 'connected');
        resolve({ ws, connectedMsg, waitFor, send, inbox });
      } catch (err) {
        reject(err);
      }
    });

    ws.once('error', reject);
  });
}

async function runTests() {
  console.log('=== Starting VibeRoom 2.0 Automated Integration Tests ===');
  const serverInstance = createVibeRoomServer({ env: {} });
  await new Promise(resolve => serverInstance.httpServer.listen(0, '127.0.0.1', resolve));
  const port = serverInstance.httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  try {
    // ------------------------------------------------------------------
    // Test 1: /health and /api/ice-config endpoints
    // ------------------------------------------------------------------
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.strictEqual(healthBody.status, 'UP');

    const iceRes = await fetch(`${baseUrl}/api/ice-config`);
    assert.strictEqual(iceRes.status, 200);
    const iceBody = await iceRes.json();
    assert.ok(Array.isArray(iceBody.iceServers) && iceBody.iceServers.length > 0);
    console.log('✔ Test 1: /health and /api/ice-config passed.');

    // ------------------------------------------------------------------
    // Test 2: Unauthenticated Access Rejection (HTTP & WebSocket)
    // ------------------------------------------------------------------
    const unauthProfRes = await fetch(`${baseUrl}/api/profile`);
    assert.strictEqual(unauthProfRes.status, 401, 'Unauthenticated /api/profile must return 401');

    const guestWs = await createTestWsClient(wsUrl, null);
    guestWs.send({ type: 'join_queue', matchMode: 'random', interests: ['Gaming'] });
    const guestErr = await guestWs.waitFor(m => m.type === 'error');
    assert.strictEqual(guestErr.code, 'UNAUTHORIZED', 'Guests must be rejected from matchmaking');
    guestWs.ws.close();
    console.log('✔ Test 2: Unauthenticated guest access rejection passed.');

    // ------------------------------------------------------------------
    // Test 3: Account Registration, Profile Isolation & Spoofing Defense
    // ------------------------------------------------------------------
    const alice = await registerUser(baseUrl, {
      email: 'alice@example.com',
      password: 'Password123!',
      display_name: 'Alice',
      gender: 'woman',
      match_preference: 'men'
    });

    // Attempt to escalate role and premium_entitled via PUT /api/profile
    const spoofRes = await fetch(`${baseUrl}/api/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`
      },
      body: JSON.stringify({
        display_name: 'Alice',
        gender: 'woman',
        match_preference: 'men',
        role: 'admin',
        premium_entitled: true
      })
    });
    const spoofData = await spoofRes.json();
    assert.strictEqual(spoofData.profile.role, 'user', 'Client must not be able to escalate role');
    assert.strictEqual(spoofData.profile.premium_entitled, false, 'Client must not set premium_entitled');
    console.log('✔ Test 3: Account registration & privilege spoofing protection passed.');

    // ------------------------------------------------------------------
    // Test 4: Mutual Gender-Preference Matchmaking & Privacy Protection
    // ------------------------------------------------------------------
    // Create Carla (Woman seeking Women) and Bob (Man seeking Women)
    const carla = await registerUser(baseUrl, {
      email: 'carla@example.com',
      password: 'Password123!',
      display_name: 'Carla',
      gender: 'woman',
      match_preference: 'women'
    });

    const bob = await registerUser(baseUrl, {
      email: 'bob@example.com',
      password: 'Password123!',
      display_name: 'Bob',
      gender: 'man',
      match_preference: 'women'
    });

    const wsAlice = await createTestWsClient(wsUrl, alice.token);
    const wsCarla = await createTestWsClient(wsUrl, carla.token);
    const wsBob = await createTestWsClient(wsUrl, bob.token);

    // Alice (Woman seeking Men) and Carla (Woman seeking Women) both join gender_preference queue.
    // Even if Carla tries to spoof gender: 'man' in join_queue payload, server uses PostgreSQL profile!
    wsAlice.send({ type: 'join_queue', matchMode: 'gender_preference', interests: ['Movies'] });
    await wsAlice.waitFor(m => m.type === 'queued');

    wsCarla.send({
      type: 'join_queue',
      matchMode: 'gender_preference',
      gender: 'man', // untrusted client field — must be ignored by server
      interests: ['Movies']
    });
    await wsCarla.waitFor(m => m.type === 'queued');

    assert.strictEqual(
      serverInstance.activeSessions.size,
      0,
      'Incompatible gender preferences (Alice seeks Men, Carla is Woman) must NOT match'
    );

    // Now Bob (Man seeking Women) joins gender_preference queue -> mutually compatible with Alice!
    wsBob.send({ type: 'join_queue', matchMode: 'gender_preference', interests: ['Movies'] });
    const [matchAlice, matchBob] = await Promise.all([
      wsAlice.waitFor(m => m.type === 'match_found'),
      wsBob.waitFor(m => m.type === 'match_found')
    ]);

    assert.strictEqual(matchAlice.sessionId, matchBob.sessionId);
    assert.strictEqual(matchAlice.partnerId, bob.userId);
    assert.strictEqual(matchBob.partnerId, alice.userId);
    assert.strictEqual(matchAlice.partnerProfile.display_name, 'Bob');
    assert.strictEqual(matchAlice.partnerProfile.email, undefined, 'Email must never be exposed');
    assert.strictEqual(matchAlice.partnerProfile.gender, undefined, 'Gender must never be exposed');
    console.log('✔ Test 4: Server-enforced mutual gender-preference matching & privacy passed.');

    // ------------------------------------------------------------------
    // Test 5: Incomplete Gender Profile Handling & Random Mode Fallback
    // ------------------------------------------------------------------
    const dan = await registerUser(baseUrl, {
      email: 'dan@example.com',
      password: 'Password123!',
      display_name: 'Dan',
      gender: 'prefer_not_to_say',
      match_preference: 'anyone'
    });
    const wsDan = await createTestWsClient(wsUrl, dan.token);

    // Dan tries gender_preference without a matchable gender -> rejected with INCOMPLETE_GENDER_PROFILE
    wsDan.send({ type: 'join_queue', matchMode: 'gender_preference', interests: ['Gaming'] });
    const incompleteErr = await wsDan.waitFor(m => m.type === 'error');
    assert.strictEqual(incompleteErr.code, 'INCOMPLETE_GENDER_PROFILE');

    // Carla (still waiting) switches to Random Chat, and Dan joins Random Chat -> they match!
    wsCarla.send({ type: 'join_queue', matchMode: 'random', interests: ['Gaming'] });
    await wsCarla.waitFor(m => m.type === 'queued');

    wsDan.send({ type: 'join_queue', matchMode: 'random', interests: ['Gaming'] });
    const [matchCarla, matchDan] = await Promise.all([
      wsCarla.waitFor(m => m.type === 'match_found'),
      wsDan.waitFor(m => m.type === 'match_found')
    ]);
    assert.strictEqual(matchCarla.sessionId, matchDan.sessionId);
    console.log('✔ Test 5: Incomplete gender profile check & Random Chat fallback passed.');

    // ------------------------------------------------------------------
    // Test 6: Session Isolation (Spoofed Session ID Rejected)
    // ------------------------------------------------------------------
    wsDan.send({
      type: 'chat_message',
      sessionId: matchAlice.sessionId, // Alice & Bob's session, not Dan's!
      text: 'Cross-session injection attempt'
    });
    const isolationErr = await wsDan.waitFor(m => m.type === 'error');
    assert.strictEqual(isolationErr.code, 'STALE_OR_INVALID_SESSION');
    console.log('✔ Test 6: Session isolation & cross-session spoofing rejection passed.');

    // ------------------------------------------------------------------
    // Test 7: Persistent Blocklist, Private Reporting & Disconnect Cleanup
    // ------------------------------------------------------------------
    const reportRes = await fetch(`${baseUrl}/api/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${alice.token}`
      },
      body: JSON.stringify({
        sessionId: matchAlice.sessionId,
        reportedUserId: bob.userId,
        reason: 'harassment',
        details: 'Integration test report'
      })
    });
    assert.strictEqual(reportRes.status, 201);
    const reportBody = await reportRes.json();
    assert.ok(reportBody.reportId.startsWith('rpt_'));

    // Alice skips Bob -> Bob gets partner_left
    wsAlice.send({ type: 'next_partner', sessionId: matchAlice.sessionId, matchMode: 'random', interests: [] });
    const bobLeft = await wsBob.waitFor(m => m.type === 'partner_left');
    assert.strictEqual(bobLeft.sessionId, matchAlice.sessionId);

    // Bob tries to join queue again -> must NOT match with Alice because Alice reported/blocked Bob
    wsBob.send({ type: 'join_queue', matchMode: 'random', interests: [] });
    await wsBob.waitFor(m => m.type === 'queued');
    assert.strictEqual(
      Array.from(serverInstance.activeSessions.values()).some(
        s => (s.userA === alice.userId && s.userB === bob.userId) || (s.userA === bob.userId && s.userB === alice.userId)
      ),
      false,
      'Blocked users must never be matched together again'
    );
    console.log('✔ Test 7: Persistent blocklist, private reporting, and skip cleanup passed.');

    // ------------------------------------------------------------------
    // Test 8: Self-Service Account Deletion & Cleanup
    // ------------------------------------------------------------------
    const delRes = await fetch(`${baseUrl}/api/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${dan.token}` }
    });
    assert.strictEqual(delRes.status, 200);

    const postDelProfRes = await fetch(`${baseUrl}/api/profile`, {
      headers: { Authorization: `Bearer ${dan.token}` }
    });
    assert.strictEqual(postDelProfRes.status, 401, 'Deleted account token must be invalidated');
    console.log('✔ Test 8: Self-service account deletion and session revocation passed.');

    wsAlice.ws.close();
    wsBob.ws.close();
    wsCarla.ws.close();
    wsDan.ws.close();
    console.log('=== All 8 VibeRoom 2.0 Integration Tests Passed! ===');
  } finally {
    await new Promise(resolve => serverInstance.httpServer.close(resolve));
  }
}

runTests().catch(err => {
  console.error('Integration test suite failed:', err);
  process.exit(1);
});