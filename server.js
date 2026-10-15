/**
 * VibeRoom Full-Stack HTTP + WebSocket Matchmaking & Signaling Server
 *
 * Responsibilities:
 * - Authoritative user IDs & session IDs
 * - Server-side waiting queue with interest-tag prioritization & random fallback
 * - Duplicate match prevention, self-match prevention, and mutual blocklist filtering
 * - Session-scoped validation for WebRTC signaling (offer/answer/candidate) and chat messages
 * - Disconnect & skip cleanup with partner notification
 * - Backend /api/report endpoint and WebSocket report event with in-memory moderation store
 * - Configurable /api/ice-config endpoint for STUN/TURN servers
 * - Static file serving from ./dist for production single-service deployments
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX_REPORTS_BUFFER = 1000;
const MAX_CHAT_LENGTH = 400;
const MIN_CHAT_INTERVAL_MS = 300;
const ALLOWED_REPORT_REASONS = new Set(['inappropriate', 'underage', 'harassment', 'spam', 'violence']);

function generateId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function sanitizeInterests(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 15)
    .map(item => String(item || '').trim().slice(0, 40))
    .filter(Boolean);
}

function sanitizeBlockedIds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 200)
    .map(item => String(item || '').trim().slice(0, 64))
    .filter(Boolean);
}

function buildIceServersFromEnv(env = process.env) {
  const stunUrls = (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);

  const iceServers = stunUrls.map(urls => ({ urls }));

  if (env.TURN_URL) {
    const turnEntry = {
      urls: env.TURN_URL.split(',').map(u => u.trim()).filter(Boolean)
    };
    if (env.TURN_USERNAME) turnEntry.username = env.TURN_USERNAME;
    if (env.TURN_CREDENTIAL) turnEntry.credential = env.TURN_CREDENTIAL;
    iceServers.push(turnEntry);
  }

  return iceServers;
}

/**
 * Factory to create an isolated VibeRoom server instance (used by production and automated tests)
 */
function createVibeRoomServer(options = {}) {
  const iceServers = options.iceServers || buildIceServersFromEnv(options.env || process.env);
  const distDir = options.distDir || path.join(__dirname, 'dist');

  // State maps
  const clients = new Map();        // userId -> ClientRecord
  const waitingQueue = [];          // Array of userIds currently waiting
  const activeSessions = new Map(); // sessionId -> { id, userA, userB, createdAt }
  const reports = [];               // Bounded in-memory list of submitted reports

  function sendJson(ws, payload) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  function removeFromQueue(userId) {
    const idx = waitingQueue.indexOf(userId);
    if (idx !== -1) {
      waitingQueue.splice(idx, 1);
    }
    const client = clients.get(userId);
    if (client) {
      client.inQueue = false;
    }
  }

  function teardownSession(sessionId, leaverUserId, reason = 'disconnected') {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    activeSessions.delete(sessionId);

    const peerIds = [session.userA, session.userB];
    for (const pid of peerIds) {
      const participant = clients.get(pid);
      if (participant && participant.activeSessionId === sessionId) {
        participant.activeSessionId = null;
        if (pid !== leaverUserId) {
          sendJson(participant.ws, {
            type: 'partner_left',
            sessionId,
            reason
          });
        }
      }
    }
  }

  function areMutuallyCompatible(clientA, clientB) {
    if (!clientA || !clientB) return false;
    if (clientA.userId === clientB.userId) return false;
    if (clientA.ws.readyState !== 1 || clientB.ws.readyState !== 1) return false;
    if (clientA.activeSessionId || clientB.activeSessionId) return false;
    if (clientA.blockedIds.has(clientB.userId)) return false;
    if (clientB.blockedIds.has(clientA.userId)) return false;
    return true;
  }

  function getSharedInterests(interestsA, interestsB) {
    const lowerMap = new Map();
    for (const tag of interestsA) {
      lowerMap.set(tag.toLowerCase(), tag);
    }
    const shared = [];
    for (const tag of interestsB) {
      const match = lowerMap.get(tag.toLowerCase());
      if (match) shared.push(match);
    }
    return shared;
  }

  /**
   * Attempt to match waiting users in the queue.
   * Priority 1: Compatible users sharing at least 1 interest tag.
   * Priority 2: FIFO compatible users (random fallback).
   */
  function attemptMatchmaking() {
    // Clean stale entries first
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      const uid = waitingQueue[i];
      const c = clients.get(uid);
      if (!c || c.ws.readyState !== 1 || c.activeSessionId) {
        waitingQueue.splice(i, 1);
        if (c) c.inQueue = false;
      }
    }

    if (waitingQueue.length < 2) return;

    let matchedIndices = null;
    let sharedTags = [];

    // Pass 1: Interest-based match
    outerInterest: for (let i = 0; i < waitingQueue.length; i++) {
      const clientA = clients.get(waitingQueue[i]);
      for (let j = i + 1; j < waitingQueue.length; j++) {
        const clientB = clients.get(waitingQueue[j]);
        if (!areMutuallyCompatible(clientA, clientB)) continue;
        const common = getSharedInterests(clientA.interests, clientB.interests);
        if (common.length > 0) {
          matchedIndices = [i, j];
          sharedTags = common;
          break outerInterest;
        }
      }
    }

    // Pass 2: Fallback FIFO match if no shared interest pair was found
    if (!matchedIndices) {
      outerFallback: for (let i = 0; i < waitingQueue.length; i++) {
        const clientA = clients.get(waitingQueue[i]);
        for (let j = i + 1; j < waitingQueue.length; j++) {
          const clientB = clients.get(waitingQueue[j]);
          if (areMutuallyCompatible(clientA, clientB)) {
            matchedIndices = [i, j];
            sharedTags = [];
            break outerFallback;
          }
        }
      }
    }

    if (!matchedIndices) return;

    const [idxA, idxB] = matchedIndices;
    const userIdA = waitingQueue[idxA];
    const userIdB = waitingQueue[idxB];

    // Remove higher index first so lower index doesn't shift
    waitingQueue.splice(idxB, 1);
    waitingQueue.splice(idxA, 1);

    const clientA = clients.get(userIdA);
    const clientB = clients.get(userIdB);
    if (!areMutuallyCompatible(clientA, clientB)) return;

    clientA.inQueue = false;
    clientB.inQueue = false;

    const sessionId = generateId('sess');
    clientA.activeSessionId = sessionId;
    clientB.activeSessionId = sessionId;

    activeSessions.set(sessionId, {
      id: sessionId,
      userA: userIdA,
      userB: userIdB,
      createdAt: Date.now()
    });

    sendJson(clientA.ws, {
      type: 'match_found',
      sessionId,
      partnerId: userIdB,
      initiator: true,
      sharedInterests: sharedTags,
      partnerInterests: clientB.interests
    });

    sendJson(clientB.ws, {
      type: 'match_found',
      sessionId,
      partnerId: userIdA,
      initiator: false,
      sharedInterests: sharedTags,
      partnerInterests: clientA.interests
    });
  }

  function enqueueClient(client, rawInterests, rawBlockedIds) {
    if (!client) return;

    // If currently in an active session, tear it down first
    if (client.activeSessionId) {
      teardownSession(client.activeSessionId, client.userId, 'skipped');
    }

    if (Array.isArray(rawInterests)) {
      client.interests = sanitizeInterests(rawInterests);
    }
    if (Array.isArray(rawBlockedIds)) {
      for (const bid of sanitizeBlockedIds(rawBlockedIds)) {
        client.blockedIds.add(bid);
      }
    }

    if (!waitingQueue.includes(client.userId)) {
      waitingQueue.push(client.userId);
    }
    client.inQueue = true;

    sendJson(client.ws, {
      type: 'queued',
      queuePosition: waitingQueue.indexOf(client.userId) + 1
    });

    attemptMatchmaking();
  }

  function recordReport({ sessionId, reportedUserId, reason, details }, reporterClient) {
    if (!reporterClient || !clients.has(reporterClient.userId)) {
      return { ok: false, status: 401, error: 'Report requires an active signaling connection' };
    }
    if (!sessionId || typeof sessionId !== 'string') {
      return { ok: false, status: 400, error: 'Missing or invalid sessionId' };
    }
    const session = activeSessions.get(sessionId);
    if (!session || reporterClient.activeSessionId !== sessionId) {
      return { ok: false, status: 409, error: 'Report must reference your active session' };
    }
    if (session.userA !== reporterClient.userId && session.userB !== reporterClient.userId) {
      return { ok: false, status: 403, error: 'Reporter is not a participant in this session' };
    }
    const actualPartnerId = session.userA === reporterClient.userId ? session.userB : session.userA;
    if (typeof reportedUserId !== 'string' || reportedUserId !== actualPartnerId) {
      return { ok: false, status: 403, error: 'Reported user must be your current chat partner' };
    }
    if (!ALLOWED_REPORT_REASONS.has(reason)) {
      return { ok: false, status: 400, error: 'Invalid report reason' };
    }

    const reportEntry = {
      reportId: generateId('rpt'),
      sessionId: sessionId.slice(0, 64),
      reportedUserId: actualPartnerId.slice(0, 64),
      reporterUserId: reporterClient.userId.slice(0, 64),
      reason,
      details: String(details || '').slice(0, 500),
      createdAt: new Date().toISOString()
    };

    if (reports.length >= MAX_REPORTS_BUFFER) reports.shift();
    reports.push(reportEntry);
    // Server-side block takes effect for all subsequent queue attempts on this connection.
    reporterClient.blockedIds.add(actualPartnerId);
    return { ok: true, status: 201, report: reportEntry };
  }

  // ==========================================
  // HTTP SERVER & REST ENDPOINTS
  // ==========================================
  const httpServer = http.createServer((req, res) => {
    // Enable CORS for local development across Vite port & backend port
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-VibeRoom-Report-Token');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. Health Endpoint
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'UP',
          service: 'viberoom-server',
          uptime: process.uptime(),
          activeConnections: clients.size,
          queueSize: waitingQueue.length,
          activeSessions: activeSessions.size,
          reportsCount: reports.length
        })
      );
      return;
    }

    // 2. ICE Server Configuration Endpoint
    if (req.method === 'GET' && pathname === '/api/ice-config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ iceServers }));
      return;
    }

    // 3. Report Submission Endpoint
    if (req.method === 'POST' && pathname === '/api/report') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 16384) {
          req.destroy();
        }
      });
      req.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        const reportToken = req.headers['x-viberoom-report-token'];
        const reporterClient = typeof reportToken === 'string'
          ? [...clients.values()].find(candidate => candidate.reportToken === reportToken)
          : null;
        if (!reporterClient) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid report token. Reconnect to the signaling server and retry.' }));
          return;
        }
        const result = recordReport(payload, reporterClient);
        if (!result.ok) {
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'recorded',
            reportId: result.report.reportId,
            createdAt: result.report.createdAt
          })
        );
      });
      return;
    }

    // 4. Serve Static Frontend Build (if dist/ exists)
    if (req.method === 'GET' && fs.existsSync(distDir)) {
      let filePath;
      try {
        const decodedPath = decodeURIComponent(pathname);
        const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
        const rootPath = path.resolve(distDir);
        filePath = path.resolve(rootPath, relativePath);
        if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.webmanifest': 'application/manifest+json',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
      // SPA fallback to index.html
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(indexHtml).pipe(res);
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        service: 'VibeRoom WebRTC Signaling & Matchmaking Server',
        wsEndpoint: '/ws',
        healthEndpoint: '/health'
      })
    );
  });

  // ==========================================
  // WEBSOCKET SERVER & SESSION EVENT HANDLERS
  // ==========================================
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  httpServer.on('upgrade', (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === '/ws' || pathname === '/') {
      wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', ws => {
    const userId = generateId('usr');
    const client = {
      userId,
      reportToken: crypto.randomBytes(24).toString('hex'),
      ws,
      interests: [],
      blockedIds: new Set(),
      activeSessionId: null,
      inQueue: false,
      lastChatAt: 0
    };
    clients.set(userId, client);

    // Send authoritative userId and ICE configuration immediately upon connection
    sendJson(ws, {
      type: 'connected',
      userId,
      reportToken: client.reportToken,
      iceServers
    });

    ws.on('message', rawData => {
      let msg;
      try {
        msg = JSON.parse(rawData.toString());
      } catch {
        sendJson(ws, { type: 'error', code: 'INVALID_JSON', message: 'Malformed JSON message' });
        return;
      }

      if (!msg || typeof msg.type !== 'string') {
        sendJson(ws, { type: 'error', code: 'INVALID_EVENT', message: 'Missing event type' });
        return;
      }

      switch (msg.type) {
        case 'join_queue': {
          enqueueClient(client, msg.interests, msg.blockedIds);
          break;
        }

        case 'leave_queue': {
          removeFromQueue(userId);
          break;
        }

        case 'next_partner': {
          if (msg.sessionId && msg.sessionId === client.activeSessionId) {
            teardownSession(msg.sessionId, userId, 'skipped');
          } else if (client.activeSessionId) {
            teardownSession(client.activeSessionId, userId, 'skipped');
          }
          enqueueClient(client, msg.interests, msg.blockedIds);
          break;
        }

        case 'leave_session': {
          removeFromQueue(userId);
          if (msg.sessionId && msg.sessionId === client.activeSessionId) {
            teardownSession(msg.sessionId, userId, 'left');
          } else if (client.activeSessionId) {
            teardownSession(client.activeSessionId, userId, 'left');
          }
          break;
        }

        case 'signal': {
          const { sessionId, data } = msg;
          if (!sessionId || sessionId !== client.activeSessionId) {
            sendJson(ws, {
              type: 'error',
              code: 'STALE_OR_INVALID_SESSION',
              message: 'Signal rejected: invalid or stale sessionId'
            });
            return;
          }

          const session = activeSessions.get(sessionId);
          if (!session || (session.userA !== userId && session.userB !== userId)) {
            sendJson(ws, {
              type: 'error',
              code: 'UNAUTHORIZED_SESSION',
              message: 'Not a participant in this session'
            });
            return;
          }

          if (!data || !['offer', 'answer', 'candidate'].includes(data.type)) {
            sendJson(ws, {
              type: 'error',
              code: 'INVALID_SIGNAL_DATA',
              message: 'Signal data must be offer, answer, or candidate'
            });
            return;
          }

          const targetUserId = session.userA === userId ? session.userB : session.userA;
          const targetClient = clients.get(targetUserId);
          if (targetClient && targetClient.activeSessionId === sessionId) {
            sendJson(targetClient.ws, {
              type: 'signal',
              sessionId,
              from: userId,
              data
            });
          }
          break;
        }

        case 'chat_message': {
          const { sessionId, text } = msg;
          if (!sessionId || sessionId !== client.activeSessionId) {
            sendJson(ws, {
              type: 'error',
              code: 'STALE_OR_INVALID_SESSION',
              message: 'Chat message rejected: invalid or stale sessionId'
            });
            return;
          }

          const session = activeSessions.get(sessionId);
          if (!session || (session.userA !== userId && session.userB !== userId)) {
            sendJson(ws, {
              type: 'error',
              code: 'UNAUTHORIZED_SESSION',
              message: 'Not a participant in this session'
            });
            return;
          }

          if (typeof text !== 'string' || !text.trim()) {
            sendJson(ws, {
              type: 'error',
              code: 'EMPTY_MESSAGE',
              message: 'Chat message cannot be empty'
            });
            return;
          }

          const now = Date.now();
          if (now - client.lastChatAt < MIN_CHAT_INTERVAL_MS) {
            sendJson(ws, {
              type: 'error',
              code: 'RATE_LIMITED',
              message: 'Sending messages too quickly'
            });
            return;
          }
          client.lastChatAt = now;

          const cleanText = text.trim().slice(0, MAX_CHAT_LENGTH);
          const targetUserId = session.userA === userId ? session.userB : session.userA;
          const targetClient = clients.get(targetUserId);
          if (targetClient && targetClient.activeSessionId === sessionId) {
            sendJson(targetClient.ws, {
              type: 'chat_message',
              sessionId,
              from: userId,
              text: cleanText,
              timestamp: now
            });
          }
          break;
        }

        case 'report': {
          const result = recordReport({
            sessionId: msg.sessionId,
            reportedUserId: msg.reportedUserId,
            reason: msg.reason,
            details: msg.details
          }, client);

          if (!result.ok) {
            sendJson(ws, {
              type: 'error',
              code: 'REPORT_ERROR',
              message: result.error
            });
            return;
          }

          client.blockedIds.add(msg.reportedUserId);
          sendJson(ws, {
            type: 'report_ack',
            status: 'recorded',
            reportId: result.report.reportId
          });
          break;
        }

        default: {
          sendJson(ws, {
            type: 'error',
            code: 'UNKNOWN_EVENT',
            message: `Unrecognized event type: ${msg.type}`
          });
          break;
        }
      }
    });

    ws.on('close', () => {
      removeFromQueue(userId);
      if (client.activeSessionId) {
        teardownSession(client.activeSessionId, userId, 'disconnected');
      }
      clients.delete(userId);
    });
  });

  return {
    httpServer,
    wss,
    clients,
    waitingQueue,
    activeSessions,
    reports
  };
}

// Start server automatically if executed directly (`node server.js`)
if (require.main === module) {
  const PORT = Number(process.env.PORT) || 8080;
  const { httpServer } = createVibeRoomServer();
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`VibeRoom Full-Stack Server listening on http://0.0.0.0:${PORT} (WebSocket: /ws)`);
  });
}

module.exports = { createVibeRoomServer };