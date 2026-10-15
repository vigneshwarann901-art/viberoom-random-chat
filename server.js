/**
 * VibeRoom 2.0 — Full-Stack HTTP + WebSocket Matchmaking, Auth & Signaling Server
 *
 * Responsibilities:
 * - Supabase Auth token validation (never trusting client-supplied userIds)
 * - Persistent user profiles (display_name, avatar_url, optional gender, match_preference)
 *   stored in Supabase PostgreSQL with Row Level Security (plus pluggable adapter for tests)
 * - Protected WebSocket & REST endpoints (unauthenticated guests cannot join matchmaking)
 * - Dual matchmaking modes:
 *   1. 'random': Open matchmaking prioritizing shared interest tags with FIFO fallback
 *   2. 'gender_preference': Server-enforced mutual gender-preference matching using
 *      authoritative stored profile values
 * - Future-ready MatchingEntitlementService (free during beta, backed by append-only credit_ledger)
 * - Persistent user_blocks and private safety_reports (90-day retention)
 * - Self-service account and profile deletion
 */

require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MAX_REPORTS_BUFFER = 1000;
const MAX_CHAT_LENGTH = 400;
const MIN_CHAT_INTERVAL_MS = 300;
const VALID_GENDERS = new Set(['woman', 'man', 'non_binary', 'prefer_not_to_say']);
const MATCHABLE_GENDERS = new Set(['woman', 'man', 'non_binary']);
const VALID_PREFERENCES = new Set(['women', 'men', 'non_binary', 'anyone']);
const VALID_REPORT_REASONS = new Set(['inappropriate', 'underage', 'harassment', 'spam', 'violence']);

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
 * Checks whether `preference` ('women' | 'men' | 'non_binary' | 'anyone')
 * includes `candidateGender` ('woman' | 'man' | 'non_binary').
 */
function preferenceIncludesGender(preference, candidateGender) {
  if (!MATCHABLE_GENDERS.has(candidateGender)) return false;
  if (preference === 'anyone') return true;
  if (preference === 'women') return candidateGender === 'woman';
  if (preference === 'men') return candidateGender === 'man';
  if (preference === 'non_binary') return candidateGender === 'non_binary';
  return false;
}

/**
 * Authoritative mutual gender-preference check:
 * Both User A and User B must have a matchable self-declared gender, and
 * A's match_preference must include B's gender AND B's match_preference must include A's gender.
 */
function areGenderPreferencesMutuallyCompatible(profileA, profileB) {
  if (!profileA || !profileB) return false;
  const genderA = profileA.gender;
  const genderB = profileB.gender;
  const prefA = profileA.match_preference || 'anyone';
  const prefB = profileB.match_preference || 'anyone';

  if (!MATCHABLE_GENDERS.has(genderA) || !MATCHABLE_GENDERS.has(genderB)) {
    return false;
  }

  return (
    preferenceIncludesGender(prefA, genderB) &&
    preferenceIncludesGender(prefB, genderA)
  );
}

function createDataAdapter(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
  const supabaseAnonKey = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '';
  const supabaseServiceKey = env.SUPABASE_SERVICE_ROLE_KEY || '';
  const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

  // Bounded in-memory backing store used when SUPABASE_URL is not configured (local dev & automated tests)
  const localUsersByEmail = new Map();
  const localUsersById = new Map();
  const localTokens = new Map();
  const localRefreshTokens = new Map();
  const localProfiles = new Map();
  const localBlocks = new Map(); // userId -> Set<blockedUserId>
  const localReports = [];
  const localCreditLedger = [];

  function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }

  function verifyPassword(password, storedHash) {
    const [salt, key] = String(storedHash || '').split(':');
    if (!salt || !key) return false;
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
  }

  function issueLocalSession(user) {
    const accessToken = `vbr_jwt_${crypto.randomBytes(18).toString('hex')}`;
    const refreshToken = `vbr_ref_${crypto.randomBytes(18).toString('hex')}`;
    const expiresAt = Date.now() + 60 * 60 * 1000;
    localTokens.set(accessToken, { userId: user.id, email: user.email, expiresAt });
    localRefreshTokens.set(refreshToken, { userId: user.id, email: user.email });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: { id: user.id, email: user.email }
    };
  }

  async function signUp({ email, password, display_name }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('A valid email address is required.');
    }
    if (!password || String(password).length < 6) {
      throw new Error('Password must be at least 6 characters.');
    }
    const cleanName = String(display_name || cleanEmail.split('@')[0]).trim().slice(0, 32);
    if (cleanName.length < 2) {
      throw new Error('Display name must be between 2 and 32 characters.');
    }

    if (isSupabaseConfigured) {
      const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          email: cleanEmail,
          password,
          data: { display_name: cleanName }
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.msg || data.error_description || data.message || 'Supabase signup failed');
      }
      const session = data.access_token
        ? {
            access_token: data.access_token,
            refresh_token: data.refresh_token,
            user: data.user
          }
        : null;
      const profile = session ? await getOrCreateProfile(data.user.id, session.access_token, cleanName) : null;
      return {
        session,
        profile,
        requiresEmailConfirmation: !session,
        message: !session ? 'Check your email to confirm your account before signing in.' : undefined
      };
    }

    if (localUsersByEmail.has(cleanEmail)) {
      throw new Error('An account with this email already exists.');
    }
    const userId = crypto.randomUUID();
    const userRecord = {
      id: userId,
      email: cleanEmail,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    };
    localUsersByEmail.set(cleanEmail, userRecord);
    localUsersById.set(userId, userRecord);

    const initialProfile = {
      id: userId,
      display_name: cleanName,
      avatar_url: null,
      gender: null,
      match_preference: 'anyone',
      profile_completed: true,
      role: 'user',
      premium_entitled: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    localProfiles.set(userId, initialProfile);
    localBlocks.set(userId, new Set());

    const session = issueLocalSession(userRecord);
    return { session, profile: { ...initialProfile }, requiresEmailConfirmation: false };
  }

  async function signIn({ email, password }) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      throw new Error('Email and password are required.');
    }

    if (isSupabaseConfigured) {
      const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email: cleanEmail, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error_description || data.msg || 'Invalid email or password');
      }
      const session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user
      };
      const profile = await getOrCreateProfile(data.user.id, data.access_token);
      return { session, profile };
    }

    const user = localUsersByEmail.get(cleanEmail);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new Error('Invalid email or password.');
    }
    const session = issueLocalSession(user);
    const profile = await getOrCreateProfile(user.id, session.access_token);
    return { session, profile };
  }

  async function refreshSession(refreshToken) {
    if (!refreshToken) throw new Error('Missing refresh token');
    if (isSupabaseConfigured) {
      const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ refresh_token: refreshToken })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('Could not refresh session');
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: data.user
      };
    }

    const record = localRefreshTokens.get(refreshToken);
    if (!record) throw new Error('Invalid refresh token');
    const user = localUsersById.get(record.userId);
    if (!user) throw new Error('User no longer exists');
    localRefreshTokens.delete(refreshToken);
    return issueLocalSession(user);
  }

  async function verifyAccessToken(token) {
    if (!token || typeof token !== 'string') return null;
    const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
    if (!cleanToken) return null;

    if (isSupabaseConfigured) {
      const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${cleanToken}`
        }
      });
      if (!res.ok) return null;
      const user = await res.json().catch(() => null);
      if (!user || !user.id) return null;
      return { id: user.id, email: user.email, token: cleanToken };
    }

    const tokenData = localTokens.get(cleanToken);
    if (!tokenData) return null;
    if (Date.now() > tokenData.expiresAt) {
      localTokens.delete(cleanToken);
      return null;
    }
    if (!localUsersById.has(tokenData.userId)) return null;
    return { id: tokenData.userId, email: tokenData.email, token: cleanToken };
  }

  async function getOrCreateProfile(userId, userToken, fallbackName = null) {
    if (isSupabaseConfigured) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=*`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${userToken}`
          }
        }
      );
      const rows = await res.json().catch(() => []);
      if (Array.isArray(rows) && rows[0]) {
        return rows[0];
      }
      const defaultName = (fallbackName || `Viber_${String(userId).slice(0, 6)}`).slice(0, 32);
      const insertRes = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },
        body: JSON.stringify({
          id: userId,
          display_name: defaultName,
          gender: null,
          match_preference: 'anyone',
          profile_completed: Boolean(fallbackName)
        })
      });
      const inserted = await insertRes.json().catch(() => []);
      return Array.isArray(inserted) ? inserted[0] : null;
    }

    let profile = localProfiles.get(userId);
    if (!profile) {
      profile = {
        id: userId,
        display_name: (fallbackName || `Viber_${String(userId).slice(0, 6)}`).slice(0, 32),
        avatar_url: null,
        gender: null,
        match_preference: 'anyone',
        profile_completed: Boolean(fallbackName),
        role: 'user',
        premium_entitled: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      localProfiles.set(userId, profile);
    }
    return { ...profile };
  }

  async function updateProfile(userId, userToken, updates) {
    // Strictly whitelist editable fields — ignore any client-supplied id, role, or premium_entitled!
    const displayName = String(updates.display_name || '').trim();
    if (displayName.length < 2 || displayName.length > 32) {
      throw new Error('Display name must be between 2 and 32 characters.');
    }

    let gender = updates.gender;
    if (gender !== null && gender !== undefined && gender !== '') {
      if (!VALID_GENDERS.has(gender)) {
        throw new Error('Invalid gender option.');
      }
    } else {
      gender = null;
    }

    const matchPreference = updates.match_preference || 'anyone';
    if (!VALID_PREFERENCES.has(matchPreference)) {
      throw new Error('Invalid match preference option.');
    }

    const avatarUrl = updates.avatar_url ? String(updates.avatar_url).trim().slice(0, 500) : null;

    if (isSupabaseConfigured) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${userToken}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
          },
          body: JSON.stringify({
            display_name: displayName,
            avatar_url: avatarUrl,
            gender,
            match_preference: matchPreference,
            profile_completed: true
          })
        }
      );
      const rows = await res.json().catch(() => []);
      if (!res.ok || !Array.isArray(rows) || !rows[0]) {
        throw new Error('Failed to update profile in Supabase.');
      }
      return rows[0];
    }

    const existing = await getOrCreateProfile(userId, userToken);
    const updated = {
      ...existing,
      id: existing.id,
      role: existing.role,
      premium_entitled: existing.premium_entitled,
      display_name: displayName,
      avatar_url: avatarUrl,
      gender,
      match_preference: matchPreference,
      profile_completed: true,
      updated_at: new Date().toISOString()
    };
    localProfiles.set(userId, updated);
    return { ...updated };
  }

  async function getBlockedUserIds(userId, userToken) {
    if (isSupabaseConfigured) {
      const res = await fetch(
        `${supabaseUrl}/rest/v1/user_blocks?blocker_id=eq.${encodeURIComponent(userId)}&select=blocked_id`,
        {
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${userToken}`
          }
        }
      );
      const rows = await res.json().catch(() => []);
      return Array.isArray(rows) ? rows.map(r => r.blocked_id) : [];
    }
    const set = localBlocks.get(userId);
    return set ? Array.from(set) : [];
  }

  async function addBlock(blockerId, blockedId, userToken) {
    if (!blockerId || !blockedId || blockerId === blockedId) {
      throw new Error('Invalid block target.');
    }
    if (isSupabaseConfigured) {
      await fetch(`${supabaseUrl}/rest/v1/user_blocks`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates'
        },
        body: JSON.stringify({ blocker_id: blockerId, blocked_id: blockedId })
      });
      return;
    }
    if (!localBlocks.has(blockerId)) localBlocks.set(blockerId, new Set());
    localBlocks.get(blockerId).add(blockedId);
  }

  async function createSafetyReport({ sessionId, reporterId, reportedId, reason, details, userToken }) {
    if (!sessionId || typeof sessionId !== 'string') {
      return { ok: false, status: 400, error: 'Missing or invalid sessionId' };
    }
    if (!reportedId || typeof reportedId !== 'string' || reportedId === reporterId) {
      return { ok: false, status: 400, error: 'Missing or invalid reportedUserId' };
    }
    if (!reason || !VALID_REPORT_REASONS.has(reason)) {
      return { ok: false, status: 400, error: 'Invalid report reason' };
    }

    const reportEntry = {
      reportId: generateId('rpt'),
      sessionId: sessionId.slice(0, 64),
      reporterUserId: reporterId,
      reportedUserId: reportedId,
      reason,
      details: String(details || '').slice(0, 500),
      createdAt: new Date().toISOString(),
      retentionExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
    };

    if (isSupabaseConfigured) {
      const res = await fetch(`${supabaseUrl}/rest/v1/safety_reports`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${userToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          report_code: reportEntry.reportId,
          session_id: reportEntry.sessionId,
          reporter_id: reporterId,
          reported_id: reportedId,
          reason: reportEntry.reason,
          details: reportEntry.details
        })
      });
      if (!res.ok) {
        return { ok: false, status: 500, error: 'Failed to store report in database' };
      }
    }

    if (localReports.length >= MAX_REPORTS_BUFFER) {
      localReports.shift();
    }
    localReports.push(reportEntry);
    await addBlock(reporterId, reportedId, userToken);

    return { ok: true, status: 201, report: reportEntry };
  }

  async function signOut(userId, userToken) {
    if (isSupabaseConfigured) {
      const res = await fetch(`${supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${userToken}`
        }
      });
      if (!res.ok) throw new Error('Supabase logout request failed');
      return;
    }

    for (const [token, data] of localTokens.entries()) {
      if (data.userId === userId) localTokens.delete(token);
    }
    for (const [token, data] of localRefreshTokens.entries()) {
      if (data.userId === userId) localRefreshTokens.delete(token);
    }
  }

  async function deleteAccount(userId, userToken) {
    if (isSupabaseConfigured) {
      if (supabaseServiceKey) {
        const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
          headers: {
            apikey: supabaseServiceKey,
            Authorization: `Bearer ${supabaseServiceKey}`
          }
        });
        if (!res.ok) throw new Error('Failed to delete account via Supabase Admin API');
      } else {
        const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/delete_own_account`, {
          method: 'POST',
          headers: {
            apikey: supabaseAnonKey,
            Authorization: `Bearer ${userToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({})
        });
        if (!rpcRes.ok) throw new Error('Failed to delete account via RPC');
      }
      return;
    }

    const user = localUsersById.get(userId);
    if (user) {
      localUsersByEmail.delete(user.email);
      localUsersById.delete(userId);
    }
    localProfiles.delete(userId);
    localBlocks.delete(userId);
    for (const [tok, data] of localTokens.entries()) {
      if (data.userId === userId) localTokens.delete(tok);
    }
  }

  function getCreditBalance(userId) {
    return localCreditLedger
      .filter(entry => entry.userId === userId)
      .reduce((sum, entry) => sum + entry.delta, 0);
  }

  return {
    isSupabaseConfigured,
    supabaseUrl,
    supabaseAnonKey,
    signUp,
    signIn,
    refreshSession,
    verifyAccessToken,
    getOrCreateProfile,
    updateProfile,
    getBlockedUserIds,
    addBlock,
    createSafetyReport,
    signOut,
    deleteAccount,
    getCreditBalance,
    localReports
  };
}

function createVibeRoomServer(options = {}) {
  const env = options.env || process.env;
  const iceServers = options.iceServers || buildIceServersFromEnv(env);
  const distDir = options.distDir || path.join(__dirname, 'dist');
  const dataAdapter = options.dataAdapter || createDataAdapter(env);

  // Phase 4: Explicit feature flag & server-side entitlement interface for future credit-based matching
  const enableCreditEnforcement = env.ENABLE_CREDIT_ENFORCEMENT === 'true';

  function checkMatchingEntitlement(userId, profile, matchMode) {
    if (matchMode !== 'gender_preference') {
      return { allowed: true, reason: 'standard_random_match' };
    }
    if (!enableCreditEnforcement) {
      return { allowed: true, reason: 'beta_free_entitlement' };
    }
    if (profile && profile.premium_entitled) {
      return { allowed: true, reason: 'premium_entitled' };
    }
    const balance = dataAdapter.getCreditBalance(userId);
    if (balance > 0) {
      return { allowed: true, reason: 'credit_balance_available' };
    }
    return {
      allowed: false,
      code: 'INSUFFICIENT_MATCH_ENTITLEMENT',
      message: 'Gender-preference matching requires an active entitlement.'
    };
  }

  const clients = new Map();        // connectionId -> ClientRecord
  const waitingQueue = [];          // Array of connectionIds currently waiting
  const activeSessions = new Map(); // sessionId -> { id, connA, connB, userA, userB, createdAt }

  function sendJson(ws, payload) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }

  function removeFromQueue(connId) {
    const idx = waitingQueue.indexOf(connId);
    if (idx !== -1) {
      waitingQueue.splice(idx, 1);
    }
    const client = clients.get(connId);
    if (client) {
      client.inQueue = false;
    }
  }

  function teardownSession(sessionId, leaverConnId, reason = 'disconnected') {
    const session = activeSessions.get(sessionId);
    if (!session) return;

    activeSessions.delete(sessionId);

    const connIds = [session.connA, session.connB];
    for (const cid of connIds) {
      const participant = clients.get(cid);
      if (participant && participant.activeSessionId === sessionId) {
        participant.activeSessionId = null;
        if (cid !== leaverConnId) {
          sendJson(participant.ws, {
            type: 'partner_left',
            sessionId,
            reason
          });
        }
      }
    }
  }

  function areClientsCompatibleForMode(clientA, clientB) {
    if (!clientA || !clientB) return false;
    if (clientA.connId === clientB.connId) return false;
    if (!clientA.userId || !clientB.userId) return false;
    // Prevent self-matching across tabs/devices of the same account
    if (clientA.userId === clientB.userId) return false;
    if (clientA.ws.readyState !== 1 || clientB.ws.readyState !== 1) return false;
    if (clientA.activeSessionId || clientB.activeSessionId) return false;

    // Mutual persistent blocklist check
    if (clientA.blockedIds.has(clientB.userId)) return false;
    if (clientB.blockedIds.has(clientA.userId)) return false;

    // If either user selected 'gender_preference', enforce authoritative mutual gender compatibility
    if (clientA.matchMode === 'gender_preference' || clientB.matchMode === 'gender_preference') {
      // Only pair gender_preference searchers with compatible profiles
      if (!areGenderPreferencesMutuallyCompatible(clientA.profile, clientB.profile)) {
        return false;
      }
    }

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

  function attemptMatchmaking() {
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      const cid = waitingQueue[i];
      const c = clients.get(cid);
      if (!c || c.ws.readyState !== 1 || c.activeSessionId || !c.userId) {
        waitingQueue.splice(i, 1);
        if (c) c.inQueue = false;
      }
    }

    if (waitingQueue.length < 2) return;

    let matchedIndices = null;
    let sharedTags = [];

    // Pass 1: Compatible users sharing at least 1 interest tag
    outerInterest: for (let i = 0; i < waitingQueue.length; i++) {
      const clientA = clients.get(waitingQueue[i]);
      for (let j = i + 1; j < waitingQueue.length; j++) {
        const clientB = clients.get(waitingQueue[j]);
        if (!areClientsCompatibleForMode(clientA, clientB)) continue;
        const common = getSharedInterests(clientA.interests, clientB.interests);
        if (common.length > 0) {
          matchedIndices = [i, j];
          sharedTags = common;
          break outerInterest;
        }
      }
    }

    // Pass 2: Compatible FIFO fallback (still strictly honoring gender_preference if selected!)
    if (!matchedIndices) {
      outerFallback: for (let i = 0; i < waitingQueue.length; i++) {
        const clientA = clients.get(waitingQueue[i]);
        for (let j = i + 1; j < waitingQueue.length; j++) {
          const clientB = clients.get(waitingQueue[j]);
          if (areClientsCompatibleForMode(clientA, clientB)) {
            matchedIndices = [i, j];
            sharedTags = [];
            break outerFallback;
          }
        }
      }
    }

    if (!matchedIndices) return;

    const [idxA, idxB] = matchedIndices;
    const connIdA = waitingQueue[idxA];
    const connIdB = waitingQueue[idxB];

    waitingQueue.splice(idxB, 1);
    waitingQueue.splice(idxA, 1);

    const clientA = clients.get(connIdA);
    const clientB = clients.get(connIdB);
    if (!areClientsCompatibleForMode(clientA, clientB)) return;

    clientA.inQueue = false;
    clientB.inQueue = false;

    const sessionId = generateId('sess');
    clientA.activeSessionId = sessionId;
    clientB.activeSessionId = sessionId;

    activeSessions.set(sessionId, {
      id: sessionId,
      connA: connIdA,
      connB: connIdB,
      userA: clientA.userId,
      userB: clientB.userId,
      createdAt: Date.now()
    });

    const resolvedMode =
      clientA.matchMode === 'gender_preference' || clientB.matchMode === 'gender_preference'
        ? 'gender_preference'
        : 'random';

    // Public partner summary — NEVER expose email, gender, or match_preference to the other user!
    const publicProfileA = {
      display_name: clientA.profile?.display_name || 'Viber',
      avatar_url: clientA.profile?.avatar_url || null
    };
    const publicProfileB = {
      display_name: clientB.profile?.display_name || 'Viber',
      avatar_url: clientB.profile?.avatar_url || null
    };

    sendJson(clientA.ws, {
      type: 'match_found',
      sessionId,
      partnerId: clientB.userId,
      partnerProfile: publicProfileB,
      initiator: true,
      matchMode: resolvedMode,
      sharedInterests: sharedTags,
      partnerInterests: clientB.interests
    });

    sendJson(clientB.ws, {
      type: 'match_found',
      sessionId,
      partnerId: clientA.userId,
      partnerProfile: publicProfileA,
      initiator: false,
      matchMode: resolvedMode,
      sharedInterests: sharedTags,
      partnerInterests: clientA.interests
    });
  }

  async function enqueueClient(client, msg) {
    if (!client) return;

    // Re-validate token if provided in message or already attached to client
    const tokenToVerify = msg.token || client.token;
    const verifiedUser = await dataAdapter.verifyAccessToken(tokenToVerify);
    if (!verifiedUser) {
      sendJson(client.ws, {
        type: 'error',
        code: 'UNAUTHORIZED',
        message: 'Authentication required: Please sign in before joining matchmaking.'
      });
      return;
    }

    client.userId = verifiedUser.id;
    client.token = verifiedUser.token;

    // Load authoritative profile and persistent blocklist from database
    const authoritativeProfile = await dataAdapter.getOrCreateProfile(verifiedUser.id, verifiedUser.token);
    const dbBlockedIds = await dataAdapter.getBlockedUserIds(verifiedUser.id, verifiedUser.token);
    client.profile = authoritativeProfile;
    for (const bid of dbBlockedIds) {
      client.blockedIds.add(bid);
    }

    const requestedMode = msg.matchMode === 'gender_preference' ? 'gender_preference' : 'random';

    // Validate gender settings when gender_preference mode is requested
    if (requestedMode === 'gender_preference') {
      if (!authoritativeProfile || !MATCHABLE_GENDERS.has(authoritativeProfile.gender)) {
        sendJson(client.ws, {
          type: 'error',
          code: 'INCOMPLETE_GENDER_PROFILE',
          message:
            'Please set your self-declared gender (Woman, Man, or Non-binary) in Profile Settings to use Match by Gender Preference, or select Random Chat.'
        });
        return;
      }

      const entitlement = checkMatchingEntitlement(verifiedUser.id, authoritativeProfile, requestedMode);
      if (!entitlement.allowed) {
        sendJson(client.ws, {
          type: 'error',
          code: entitlement.code,
          message: entitlement.message
        });
        return;
      }
    }

    if (client.activeSessionId) {
      teardownSession(client.activeSessionId, client.connId, 'skipped');
    }

    // Prevent duplicate queue entries for the same user across other connections
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
      const queuedClient = clients.get(waitingQueue[i]);
      if (queuedClient && queuedClient.userId === client.userId && queuedClient.connId !== client.connId) {
        waitingQueue.splice(i, 1);
        queuedClient.inQueue = false;
      }
    }

    client.matchMode = requestedMode;
    client.interests = sanitizeInterests(msg.interests);

    if (!waitingQueue.includes(client.connId)) {
      waitingQueue.push(client.connId);
    }
    client.inQueue = true;

    sendJson(client.ws, {
      type: 'queued',
      matchMode: requestedMode,
      queuePosition: waitingQueue.indexOf(client.connId) + 1
    });

    attemptMatchmaking();
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 32768) {
          req.destroy();
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        if (!body) return resolve({});
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
          service: 'viberoom-server-v2',
          uptime: process.uptime(),
          supabaseConfigured: dataAdapter.isSupabaseConfigured,
          activeConnections: clients.size,
          queueSize: waitingQueue.length,
          activeSessions: activeSessions.size,
          reportsCount: dataAdapter.localReports.length
        })
      );
      return;
    }

    // 2. ICE Configuration Endpoint
    if (req.method === 'GET' && pathname === '/api/ice-config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ iceServers }));
      return;
    }

    // 3. Auth Endpoints (Signup, Login, Refresh, Reset Password, OAuth URL, Logout)
    if (req.method === 'POST' && pathname === '/api/auth/signup') {
      try {
        const body = await readJsonBody(req);
        const result = await dataAdapter.signUp(body);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/login') {
      try {
        const body = await readJsonBody(req);
        const result = await dataAdapter.signIn(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/refresh') {
      try {
        const body = await readJsonBody(req);
        const session = await dataAdapter.refreshSession(body.refresh_token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session }));
      } catch (err) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/reset-password') {
      try {
        const body = await readJsonBody(req);
        if (!body.email || !String(body.email).includes('@')) {
          throw new Error('Please provide a valid email address.');
        }
        if (dataAdapter.isSupabaseConfigured) {
          await fetch(`${dataAdapter.supabaseUrl}/auth/v1/recover`, {
            method: 'POST',
            headers: {
              apikey: dataAdapter.supabaseAnonKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email: String(body.email).trim() })
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            message: 'If an account matches that email, a password reset link has been sent.'
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/auth/oauth-url') {
      const provider = parsedUrl.searchParams.get('provider') || 'google';
      const redirectTo = parsedUrl.searchParams.get('redirectTo') || '';
      if (!dataAdapter.isSupabaseConfigured) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Google OAuth requires SUPABASE_URL and SUPABASE_ANON_KEY configured on the server.'
          })
        );
        return;
      }
      const url = `${dataAdapter.supabaseUrl}/auth/v1/authorize?provider=${encodeURIComponent(
        provider
      )}&redirect_to=${encodeURIComponent(redirectTo)}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/auth/logout') {
      const authorization = String(req.headers.authorization || '');
      const token = authorization.replace(/^Bearer\s+/i, '').trim();
      const verified = await dataAdapter.verifyAccessToken(authorization);
      let logoutWarning = null;
      if (verified) {
        try {
          await dataAdapter.signOut(verified.id, verified.token);
        } catch (err) {
          // Still invalidate live signaling connections locally if provider revocation fails.
          logoutWarning = err.message || 'Provider token revocation failed';
        }
      }
      for (const client of clients.values()) {
        if ((verified && client.userId === verified.id) || (token && client.token === token)) {
          removeFromQueue(client.connId);
          if (client.activeSessionId) teardownSession(client.activeSessionId, client.connId, 'signed_out');
          client.userId = null;
          client.token = null;
          client.profile = null;
          client.blockedIds.clear();
          sendJson(client.ws, { type: 'signed_out' });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'logged_out', ...(logoutWarning ? { warning: logoutWarning } : {}) }));
      return;
    }

    // 4. Protected Profile Endpoints (GET & PUT /api/profile)
    if (pathname === '/api/profile' && (req.method === 'GET' || req.method === 'PUT')) {
      const verified = await dataAdapter.verifyAccessToken(req.headers.authorization);
      if (!verified) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid or expired access token' }));
        return;
      }

      if (req.method === 'GET') {
        const profile = await dataAdapter.getOrCreateProfile(verified.id, verified.token);
        const blockedIds = await dataAdapter.getBlockedUserIds(verified.id, verified.token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ profile, blockedIds }));
        return;
      }

      try {
        const body = await readJsonBody(req);
        const updated = await dataAdapter.updateProfile(verified.id, verified.token, body);
        // Update any active WebSocket connections for this user
        for (const client of clients.values()) {
          if (client.userId === verified.id) {
            client.profile = updated;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ profile: updated }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 5. Protected Persistent Block Endpoint (POST /api/block)
    if (req.method === 'POST' && pathname === '/api/block') {
      const verified = await dataAdapter.verifyAccessToken(req.headers.authorization);
      if (!verified) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        const body = await readJsonBody(req);
        await dataAdapter.addBlock(verified.id, body.blockedUserId, verified.token);
        for (const client of clients.values()) {
          if (client.userId === verified.id && body.blockedUserId) {
            client.blockedIds.add(body.blockedUserId);
          }
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'blocked', blockedUserId: body.blockedUserId }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 6. Protected Safety Report Endpoint (POST /api/report)
    if (req.method === 'POST' && pathname === '/api/report') {
      const verified = await dataAdapter.verifyAccessToken(req.headers.authorization);
      if (!verified) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Must be signed in to submit a report' }));
        return;
      }
      try {
        const payload = await readJsonBody(req);
        const result = await dataAdapter.createSafetyReport({
          sessionId: payload.sessionId,
          reporterId: verified.id,
          reportedId: payload.reportedUserId,
          reason: payload.reason,
          details: payload.details,
          userToken: verified.token
        });
        if (!result.ok) {
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
          return;
        }
        for (const client of clients.values()) {
          if (client.userId === verified.id) {
            client.blockedIds.add(payload.reportedUserId);
          }
        }
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'recorded',
            reportId: result.report.reportId,
            createdAt: result.report.createdAt,
            retentionExpiresAt: result.report.retentionExpiresAt
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 7. Protected Account Deletion Endpoint (DELETE /api/account)
    if (req.method === 'DELETE' && pathname === '/api/account') {
      const verified = await dataAdapter.verifyAccessToken(req.headers.authorization);
      if (!verified) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      try {
        // Tear down any active queues/sessions for this user
        for (const client of clients.values()) {
          if (client.userId === verified.id) {
            removeFromQueue(client.connId);
            if (client.activeSessionId) {
              teardownSession(client.activeSessionId, client.connId, 'disconnected');
            }
            client.userId = null;
            client.token = null;
            client.profile = null;
            client.blockedIds.clear();
            sendJson(client.ws, { type: 'account_deleted' });
          }
        }
        await dataAdapter.deleteAccount(verified.id, verified.token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'account_deleted' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 8. Static Frontend Serving (if dist/ exists)
    if (req.method === 'GET' && fs.existsSync(distDir)) {
      let filePath = path.join(distDir, pathname === '/' ? 'index.html' : pathname);
      if (!filePath.startsWith(distDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon'
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
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
        service: 'VibeRoom 2.0 WebRTC Signaling, Auth & Matchmaking Server',
        wsEndpoint: '/ws',
        healthEndpoint: '/health'
      })
    );
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (parsedUrl.pathname === '/ws' || parsedUrl.pathname === '/') {
      wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws, request) => {
    const connId = generateId('conn');
    const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const queryToken = parsedUrl.searchParams.get('token');

    const client = {
      connId,
      userId: null,
      token: null,
      profile: null,
      ws,
      matchMode: 'random',
      interests: [],
      blockedIds: new Set(),
      activeSessionId: null,
      inQueue: false,
      lastChatAt: 0
    };
    clients.set(connId, client);

    if (queryToken) {
      const verified = await dataAdapter.verifyAccessToken(queryToken);
      if (verified) {
        client.userId = verified.id;
        client.token = verified.token;
        client.profile = await dataAdapter.getOrCreateProfile(verified.id, verified.token);
        const blocked = await dataAdapter.getBlockedUserIds(verified.id, verified.token);
        for (const bid of blocked) client.blockedIds.add(bid);
      }
    }

    sendJson(ws, {
      type: 'connected',
      connId,
      authenticated: Boolean(client.userId),
      userId: client.userId,
      profile: client.profile,
      iceServers
    });

    ws.on('message', async rawData => {
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
        case 'authenticate': {
          const verified = await dataAdapter.verifyAccessToken(msg.token);
          if (!verified) {
            sendJson(ws, {
              type: 'error',
              code: 'UNAUTHORIZED',
              message: 'Invalid or expired access token'
            });
            return;
          }
          client.userId = verified.id;
          client.token = verified.token;
          client.profile = await dataAdapter.getOrCreateProfile(verified.id, verified.token);
          const blocked = await dataAdapter.getBlockedUserIds(verified.id, verified.token);
          client.blockedIds = new Set(blocked);
          sendJson(ws, {
            type: 'authenticated',
            userId: client.userId,
            profile: client.profile
          });
          break;
        }

        case 'join_queue': {
          await enqueueClient(client, msg);
          break;
        }

        case 'leave_queue': {
          removeFromQueue(connId);
          break;
        }

        case 'next_partner': {
          if (msg.sessionId && msg.sessionId === client.activeSessionId) {
            teardownSession(msg.sessionId, connId, 'skipped');
          } else if (client.activeSessionId) {
            teardownSession(client.activeSessionId, connId, 'skipped');
          }
          await enqueueClient(client, msg);
          break;
        }

        case 'leave_session': {
          removeFromQueue(connId);
          if (msg.sessionId && msg.sessionId === client.activeSessionId) {
            teardownSession(msg.sessionId, connId, 'left');
          } else if (client.activeSessionId) {
            teardownSession(client.activeSessionId, connId, 'left');
          }
          break;
        }

        case 'signal': {
          if (!client.userId) {
            sendJson(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not authenticated' });
            return;
          }
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
          if (!session || (session.connA !== connId && session.connB !== connId)) {
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

          const targetConnId = session.connA === connId ? session.connB : session.connA;
          const targetClient = clients.get(targetConnId);
          if (targetClient && targetClient.activeSessionId === sessionId) {
            sendJson(targetClient.ws, {
              type: 'signal',
              sessionId,
              from: client.userId,
              data
            });
          }
          break;
        }

        case 'chat_message': {
          if (!client.userId) {
            sendJson(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Not authenticated' });
            return;
          }
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
          if (!session || (session.connA !== connId && session.connB !== connId)) {
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
          const targetConnId = session.connA === connId ? session.connB : session.connA;
          const targetClient = clients.get(targetConnId);
          if (targetClient && targetClient.activeSessionId === sessionId) {
            sendJson(targetClient.ws, {
              type: 'chat_message',
              sessionId,
              from: client.userId,
              text: cleanText,
              timestamp: now
            });
          }
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
      removeFromQueue(connId);
      if (client.activeSessionId) {
        teardownSession(client.activeSessionId, connId, 'disconnected');
      }
      clients.delete(connId);
    });
  });

  return {
    httpServer,
    wss,
    clients,
    waitingQueue,
    activeSessions,
    reports: dataAdapter.localReports,
    dataAdapter
  };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 8080;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (process.env.NODE_ENV === 'production' && (!supabaseUrl || !supabaseAnonKey)) {
    console.error('Refusing to start in production without SUPABASE_URL and SUPABASE_ANON_KEY. Configure persistent authentication before deploying VibeRoom 2.0.');
    process.exit(1);
  }
  const { httpServer } = createVibeRoomServer();
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`VibeRoom 2.0 Server listening on http://0.0.0.0:${PORT} (WebSocket: /ws)`);
  });
}

module.exports = {
  createVibeRoomServer,
  areGenderPreferencesMutuallyCompatible,
  preferenceIncludesGender
};