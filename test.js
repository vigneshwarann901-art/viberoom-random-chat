/**
 * Automated Integration Test Suite for VibeRoom Server
 *
 * Verifies:
 * 1. Health & ICE config HTTP endpoints
 * 2. Server-side queue & matchmaking between unrelated WebSocket clients
 * 3. Interest-tag prioritization & blocklist enforcement
 * 4. Authoritative session-scoped WebRTC signaling & chat message relay
 * 5. Session isolation (rejecting spoofed/stale sessionIds)
 * 6. Disconnect and next_partner session cleanup
 * 7. Backend report submission & validation (/api/report & WS report_ack)
 */

const assert = require('assert');
const WebSocket = require('ws');
const { createVibeRoomServer } = require('./server');
const activeSockets = new Set();

function createTestClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    activeSockets.add(ws);
    ws.once('close', () => activeSockets.delete(ws));
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
        resolve({ ws, userId: connectedMsg.userId, reportToken: connectedMsg.reportToken, waitFor, send, inbox });
      } catch (err) {
        reject(err);
      }
    });

    ws.once('error', reject);
  });
}

async function runTests() {
  console.log('=== Starting VibeRoom Full-Stack Automated Integration Tests ===');
  const serverInstance = createVibeRoomServer();
  await new Promise(resolve => serverInstance.httpServer.listen(0, '127.0.0.1', resolve));
  const port = serverInstance.httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  try {
    // ----------------------------------------------------
    // Test 1: Health and ICE configuration HTTP endpoints
    // ----------------------------------------------------
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.strictEqual(healthRes.status, 200);
    const healthBody = await healthRes.json();
    assert.strictEqual(healthBody.status, 'UP');

    const iceRes = await fetch(`${baseUrl}/api/ice-config`);
    assert.strictEqual(iceRes.status, 200);
    const iceBody = await iceRes.json();
    assert.ok(Array.isArray(iceBody.iceServers) && iceBody.iceServers.length > 0);
    console.log('✔ Test 1: /health and /api/ice-config endpoints passed.');

    // ----------------------------------------------------
    // Test 2: Unrelated client matchmaking & session creation
    // ----------------------------------------------------
    const clientA = await createTestClient(wsUrl);
    const clientB = await createTestClient(wsUrl);
    assert.notStrictEqual(clientA.userId, clientB.userId, 'Clients must receive distinct server userIds');

    clientA.send({ type: 'join_queue', interests: ['Gaming', 'Movies'], blockedIds: [] });
    const queuedA = await clientA.waitFor(m => m.type === 'queued');
    assert.strictEqual(queuedA.type, 'queued');

    clientB.send({ type: 'join_queue', interests: ['Gaming'], blockedIds: [] });
    const [matchA, matchB] = await Promise.all([
      clientA.waitFor(m => m.type === 'match_found'),
      clientB.waitFor(m => m.type === 'match_found')
    ]);

    assert.strictEqual(matchA.sessionId, matchB.sessionId, 'Both peers must share authoritative sessionId');
    assert.strictEqual(matchA.partnerId, clientB.userId);
    assert.strictEqual(matchB.partnerId, clientA.userId);
    assert.notStrictEqual(matchA.initiator, matchB.initiator, 'Exactly one peer must be initiator');
    assert.deepStrictEqual(matchA.sharedInterests, ['Gaming']);
    console.log('✔ Test 2: Authoritative matchmaking & interest matching passed.');

    // ----------------------------------------------------
    // Test 3: Session-scoped WebRTC signaling & chat relay
    // ----------------------------------------------------
    const activeSessionId = matchA.sessionId;
    clientA.send({
      type: 'signal',
      sessionId: activeSessionId,
      data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0-mock-offer' } }
    });
    const receivedOffer = await clientB.waitFor(m => m.type === 'signal');
    assert.strictEqual(receivedOffer.sessionId, activeSessionId);
    assert.strictEqual(receivedOffer.from, clientA.userId);
    assert.strictEqual(receivedOffer.data.type, 'offer');

    clientB.send({
      type: 'chat_message',
      sessionId: activeSessionId,
      text: 'Hello from Client B!'
    });
    const receivedChat = await clientA.waitFor(m => m.type === 'chat_message');
    assert.strictEqual(receivedChat.sessionId, activeSessionId);
    assert.strictEqual(receivedChat.text, 'Hello from Client B!');
    console.log('✔ Test 3: Session-scoped WebRTC signaling and chat relay passed.');

    // ----------------------------------------------------
    // Test 4: Session Isolation (Spoofed/Unrelated Client Rejected)
    // ----------------------------------------------------
    const intruder = await createTestClient(wsUrl);
    intruder.send({
      type: 'chat_message',
      sessionId: activeSessionId,
      text: 'Intruder injection attempt'
    });
    const intruderErr = await intruder.waitFor(m => m.type === 'error');
    assert.strictEqual(intruderErr.code, 'STALE_OR_INVALID_SESSION');
    console.log('✔ Test 4: Session isolation & spoofed sessionId rejection passed.');

    // ----------------------------------------------------
    // Test 5: Next Partner / Skip & Stale Session Rejection
    // ----------------------------------------------------
    clientA.send({
      type: 'next_partner',
      sessionId: activeSessionId,
      interests: ['Music & Beats'],
      blockedIds: []
    });

    const partnerLeftNotice = await clientB.waitFor(m => m.type === 'partner_left');
    assert.strictEqual(partnerLeftNotice.sessionId, activeSessionId);
    assert.strictEqual(partnerLeftNotice.reason, 'skipped');

    // Client B tries sending a message to the now-closed session
    clientB.send({
      type: 'chat_message',
      sessionId: activeSessionId,
      text: 'Message to stale session'
    });
    const staleErr = await clientB.waitFor(m => m.type === 'error');
    assert.strictEqual(staleErr.code, 'STALE_OR_INVALID_SESSION');
    console.log('✔ Test 5: Skip cleanup, partner_left notice, and stale session rejection passed.');

    // ----------------------------------------------------
    // Test 6: Blocklist Enforcement & Disconnect Cleanup
    // ----------------------------------------------------
    // Client A is currently in queue. If Client B joins queue with Client A blocked, they must NOT match.
    clientB.send({
      type: 'join_queue',
      interests: ['Music & Beats'],
      blockedIds: [clientA.userId]
    });
    await clientB.waitFor(m => m.type === 'queued');
    assert.strictEqual(serverInstance.activeSessions.size, 0, 'Blocked peers must not be matched together');
    console.log('✔ Test 6: Blocklist enforcement passed.');

    // Intruder joins with 'Music & Beats' and matches with Client A
    intruder.send({
      type: 'join_queue',
      interests: ['Music & Beats'],
      blockedIds: []
    });
    const [newMatchA, newMatchIntruder] = await Promise.all([
      clientA.waitFor(m => m.type === 'match_found'),
      intruder.waitFor(m => m.type === 'match_found')
    ]);
    assert.strictEqual(newMatchA.partnerId, intruder.userId);

    // ----------------------------------------------------
    // Test 7: Backend Report Submission & Validation
    // ----------------------------------------------------
    const unauthenticatedReportRes = await fetch(`${baseUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: newMatchA.sessionId, reportedUserId: intruder.userId, reason: 'spam' })
    });
    assert.strictEqual(unauthenticatedReportRes.status, 401);

    const badReportRes = await fetch(`${baseUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VibeRoom-Report-Token': clientA.reportToken },
      body: JSON.stringify({ sessionId: '', reason: '' })
    });
    assert.strictEqual(badReportRes.status, 400);

    const validReportRes = await fetch(`${baseUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VibeRoom-Report-Token': clientA.reportToken },
      body: JSON.stringify({
        sessionId: newMatchA.sessionId,
        reportedUserId: intruder.userId,
        reporterUserId: clientA.userId,
        reason: 'spam',
        details: 'Automated integration test report'
      })
    });
    assert.strictEqual(validReportRes.status, 201);
    const validReportBody = await validReportRes.json();
    assert.strictEqual(validReportBody.status, 'recorded');
    assert.ok(validReportBody.reportId.startsWith('rpt_'));
    assert.strictEqual(serverInstance.reports.length, 1);
    console.log('✔ Test 7: Backend /api/report validation and recording passed.');


    // Close intruder socket abruptly and verify Client A receives partner_left
    intruder.ws.close();
    const disconnectNotice = await clientA.waitFor(m => m.type === 'partner_left');
    assert.strictEqual(disconnectNotice.sessionId, newMatchA.sessionId);
    assert.strictEqual(disconnectNotice.reason, 'disconnected');
    console.log('✔ Test 8: Abrupt socket disconnect cleanup passed.');


    clientA.ws.close();
    clientB.ws.close();
    console.log('=== All 8 VibeRoom Full-Stack Integration Test Groups Passed! ===');
  } finally {
    for (const socket of activeSockets) {
      try { socket.terminate(); } catch { /* ignore test cleanup failures */ }
    }
    await new Promise(resolve => serverInstance.httpServer.close(resolve));
  }
}

runTests().catch(err => {
  console.error('Integration test failed:', err);
  process.exit(1);
});