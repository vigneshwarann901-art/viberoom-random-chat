import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Camera, CameraOff, Mic, MicOff, SkipForward, PhoneOff,
  Flag, ShieldAlert, Send, Sparkles, Tag,
  AlertTriangle, RefreshCw, Sliders, MessageSquare,
  CheckCircle2, ChevronRight, X, EyeOff, Wifi, WifiOff, Server,
  User, LogOut, Lock, Mail, KeyRound, Trash2, Users, Shuffle, HeartHandshake, Info
} from 'lucide-react';

// ==========================================
// DEFAULT FALLBACK WEBRTC CONFIGURATION
// ==========================================
const DEFAULT_RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

const INTEREST_TAGS = [
  'Chill & Chat', 'Gaming', 'Music & Beats',
  'Tech & Code', 'Anime & Manga', 'Movies',
  'Languages', 'Fitness', 'Art & Design'
];

const GENDER_OPTIONS = [
  { id: 'woman', label: 'Woman' },
  { id: 'man', label: 'Man' },
  { id: 'non_binary', label: 'Non-binary' },
  { id: 'prefer_not_to_say', label: 'Prefer not to say' }
];

const MATCH_PREFERENCE_OPTIONS = [
  { id: 'anyone', label: 'Anyone' },
  { id: 'women', label: 'Women' },
  { id: 'men', label: 'Men' },
  { id: 'non_binary', label: 'Non-binary people' }
];

const REPORT_REASONS = [
  { id: 'inappropriate', label: 'Inappropriate or NSFW Behavior' },
  { id: 'underage', label: 'Suspected Underage (< 18)' },
  { id: 'harassment', label: 'Harassment or Hate Speech' },
  { id: 'spam', label: 'Commercial Spam or Botting' },
  { id: 'violence', label: 'Violence or Dangerous Acts' }
];

function resolveEnvVar(name) {
  try {
    if (typeof window !== 'undefined' && window[name]) return window[name];
    if (typeof process !== 'undefined' && process.env && process.env[name]) return process.env[name];
  } catch {
    // Ignore environment access issues in sandboxed frames
  }
  return '';
}

function resolveDefaultWsUrl() {
  const fromEnv = resolveEnvVar('VITE_WS_URL');
  if (fromEnv) return fromEnv;

  try {
    const saved = sessionStorage.getItem('viberoom_ws_url');
    if (saved) return saved;
  } catch {
    // Ignore storage errors
  }

  if (
    typeof window !== 'undefined' &&
    window.location &&
    window.location.host &&
    (window.location.protocol === 'http:' || window.location.protocol === 'https:')
  ) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/ws`;
  }

  return 'ws://localhost:8080/ws';
}

function deriveHttpBaseUrl(wsUrl) {
  try {
    const parsed = new URL(wsUrl);
    const httpProto = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return `${httpProto}//${parsed.host}`;
  } catch {
    return '';
  }
}

export default function App() {
  // --- Lobby & Navigation State ---
  const [inLobby, setInLobby] = useState(true);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [selectedInterests, setSelectedInterests] = useState(['Chill & Chat']);
  const [matchMode, setMatchMode] = useState('random'); // 'random' | 'gender_preference'
  const [showGuidelines, setShowGuidelines] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  // --- Signaling & Backend Server Configuration ---
  const [wsUrl, setWsUrl] = useState(resolveDefaultWsUrl);
  const [wsUrlInput, setWsUrlInput] = useState(resolveDefaultWsUrl);
  const [serverStatus, setServerStatus] = useState('disconnected');
  const [serverError, setServerError] = useState(null);
  const [rtcConfig, setRtcConfig] = useState(DEFAULT_RTC_CONFIG);

  // --- Authentication & Persistent Profile State ---
  // authView: 'login' | 'register' | 'reset'
  const [authView, setAuthView] = useState('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authDisplayName, setAuthDisplayName] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authNotice, setAuthNotice] = useState(null);
  const [authSession, setAuthSession] = useState(() => {
    try {
      const saved = localStorage.getItem('viberoom_auth_session');
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Authoritative profile loaded from PostgreSQL / backend
  const [profile, setProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({
    display_name: '',
    avatar_url: '',
    gender: 'prefer_not_to_say',
    match_preference: 'anyone'
  });
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState(null);

  // --- Matchmaking & Authoritative Session State ---
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [sessionId, setSessionId] = useState(null);
  const [partnerId, setPartnerId] = useState(null);
  const [partnerProfile, setPartnerProfile] = useState(null);
  const [partnerInterests, setPartnerInterests] = useState([]);
  const [matchedCommonTag, setMatchedCommonTag] = useState(null);
  const [activeMatchMode, setActiveMatchMode] = useState('random');
  const [blockedUsers, setBlockedUsers] = useState([]);

  // --- Report Submission State ---
  const [selectedReportReason, setSelectedReportReason] = useState(REPORT_REASONS[0].id);
  const [reportDetails, setReportDetails] = useState('');
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportError, setReportError] = useState(null);

  // --- Media & Hardware State ---
  const [localStream, setLocalStream] = useState(null);
  const [isAudioMuted, setIsAudioMuted] = useState(false);
  const [isVideoMuted, setIsVideoMuted] = useState(false);
  const [cameraPermissionError, setCameraPermissionError] = useState(null);

  // --- Real-Time Chat State ---
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const pcRef = useRef(null);
  const wsRef = useRef(null);
  const activeSessionIdRef = useRef(null);
  const currentPartnerIdRef = useRef(null);
  const pendingCandidatesRef = useRef([]);
  const localStreamRef = useRef(null);
  const rtcConfigRef = useRef(DEFAULT_RTC_CONFIG);
  const selectedInterestsRef = useRef(selectedInterests);
  const matchModeRef = useRef(matchMode);
  const authSessionRef = useRef(authSession);
  const isMobileChatOpenRef = useRef(isMobileChatOpen);
  const chatBottomRef = useRef(null);
  const lastMessageTimestamp = useRef(0);
  const pendingReportCallbackRef = useRef(null);

  useEffect(() => {
    selectedInterestsRef.current = selectedInterests;
  }, [selectedInterests]);

  useEffect(() => {
    matchModeRef.current = matchMode;
  }, [matchMode]);

  useEffect(() => {
    authSessionRef.current = authSession;
  }, [authSession]);

  useEffect(() => {
    isMobileChatOpenRef.current = isMobileChatOpen;
  }, [isMobileChatOpen]);

  useEffect(() => {
    rtcConfigRef.current = rtcConfig;
  }, [rtcConfig]);

  const showToast = useCallback((msg, duration = 4000) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(prev => (prev === msg ? null : prev));
    }, duration);
  }, []);

  const persistAuthSession = useCallback((sessionData) => {
    setAuthSession(sessionData);
    authSessionRef.current = sessionData;
    try {
      if (sessionData) {
        localStorage.setItem('viberoom_auth_session', JSON.stringify(sessionData));
      } else {
        localStorage.removeItem('viberoom_auth_session');
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  // Supabase implicit OAuth callback: read tokens from the URL fragment and immediately
  // remove them from the address bar. If OAuth is configured for PKCE/code flow, use the
  // Supabase JS client/code exchange instead of expecting this fragment format.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.location.hash) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const errorDescription = params.get('error_description') || params.get('error');

    if (accessToken && refreshToken) {
      const expiresIn = Number(params.get('expires_in') || 3600);
      persistAuthSession({
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresIn,
        token_type: params.get('token_type') || 'bearer',
        expires_at: Math.floor(Date.now() / 1000) + expiresIn
      });
      window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
      setAuthError(null);
      setAuthNotice('Google sign-in completed. Loading your VibeRoom profile…');
      showToast('Signed in successfully.');
    } else if (errorDescription) {
      window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
      setAuthError(errorDescription);
    }
  }, [persistAuthSession, showToast]);

  const apiFetch = useCallback(async (path, options = {}) => {
    const baseUrl = deriveHttpBaseUrl(wsUrl);
    const token = authSessionRef.current?.access_token;
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  }, [wsUrl]);

  const fetchUserProfile = useCallback(async (overrideToken = null) => {
    const token = overrideToken || authSessionRef.current?.access_token;
    if (!token) return null;
    try {
      const baseUrl = deriveHttpBaseUrl(wsUrl);
      const res = await fetch(`${baseUrl}/api/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 401) {
        // Attempt token refresh if refresh_token is available
        const refreshToken = authSessionRef.current?.refresh_token;
        if (refreshToken) {
          const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
          });
          if (refreshRes.ok) {
            const refreshed = await refreshRes.json();
            if (refreshed.session) {
              persistAuthSession(refreshed.session);
              return fetchUserProfile(refreshed.session.access_token);
            }
          }
        }
        persistAuthSession(null);
        setProfile(null);
        return null;
      }
      if (!res.ok) return null;
      const data = await res.json();
      if (data.profile) {
        setProfile(data.profile);
        setProfileForm({
          display_name: data.profile.display_name || '',
          avatar_url: data.profile.avatar_url || '',
          gender: data.profile.gender || 'prefer_not_to_say',
          match_preference: data.profile.match_preference || 'anyone'
        });
      }
      if (Array.isArray(data.blockedIds)) {
        setBlockedUsers(data.blockedIds);
      }
      return data.profile;
    } catch {
      return null;
    }
  }, [wsUrl, persistAuthSession]);

  // Fetch ICE configuration on mount or URL change
  useEffect(() => {
    let isMounted = true;
    const baseUrl = deriveHttpBaseUrl(wsUrl);
    fetch(`${baseUrl}/api/ice-config`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (isMounted && data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          setRtcConfig({
            iceServers: data.iceServers,
            iceCandidatePoolSize: 10
          });
        }
      })
      .catch(() => {});
    return () => {
      isMounted = false;
    };
  }, [wsUrl]);

  // Load profile when session exists
  useEffect(() => {
    if (authSession?.access_token) {
      fetchUserProfile(authSession.access_token);
    } else {
      setProfile(null);
    }
  }, [authSession?.access_token, fetchUserProfile]);

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError(null);
    setAuthNotice(null);
    setAuthLoading(true);

    const baseUrl = deriveHttpBaseUrl(wsUrl);
    try {
      if (authView === 'reset') {
        const res = await fetch(`${baseUrl}/api/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: authEmail.trim() })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not send password reset email');
        setAuthNotice(data.message || 'If that account exists, a password reset link has been sent to your email.');
        setAuthLoading(false);
        return;
      }

      const endpoint = authView === 'register' ? '/api/auth/signup' : '/api/auth/login';
      const payload = {
        email: authEmail.trim(),
        password: authPassword,
        ...(authView === 'register' ? { display_name: authDisplayName.trim() } : {})
      };

      const res = await fetch(`${baseUrl}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      if (data.requiresEmailConfirmation && !data.session) {
        setAuthNotice(
          data.message ||
            'Registration submitted! Please check your email inbox to verify your address before logging in.'
        );
        setAuthView('login');
        setAuthLoading(false);
        return;
      }

      if (data.session) {
        persistAuthSession(data.session);
        if (data.profile) {
          setProfile(data.profile);
          setProfileForm({
            display_name: data.profile.display_name || '',
            avatar_url: data.profile.avatar_url || '',
            gender: data.profile.gender || 'prefer_not_to_say',
            match_preference: data.profile.match_preference || 'anyone'
          });
          if (!data.profile.profile_completed) {
            setShowProfileModal(true);
          }
        } else {
          await fetchUserProfile(data.session.access_token);
        }
        // Authenticate active WebSocket if already open
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({
              type: 'authenticate',
              token: data.session.access_token
            })
          );
        }
        showToast(authView === 'register' ? 'Account created! Complete your profile preferences.' : 'Signed in to VibeRoom.');
      }
    } catch (err) {
      setAuthError(err.message || 'Could not reach authentication server.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleOAuth = async () => {
    setAuthError(null);
    const baseUrl = deriveHttpBaseUrl(wsUrl);
    try {
      const res = await fetch(
        `${baseUrl}/api/auth/oauth-url?provider=google&redirectTo=${encodeURIComponent(window.location.origin)}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) {
        throw new Error(
          data.error ||
            'Google OAuth requires SUPABASE_URL and Google Provider configured in your Supabase Dashboard.'
        );
      }
      window.location.href = data.url;
    } catch (err) {
      setAuthError(err.message);
    }
  };

  const handleSaveProfile = async (e) => {
    e?.preventDefault();
    setProfileError(null);
    setProfileSaving(true);
    try {
      const data = await apiFetch('/api/profile', {
        method: 'PUT',
        body: JSON.stringify({
          display_name: profileForm.display_name.trim(),
          avatar_url: profileForm.avatar_url.trim() || null,
          gender: profileForm.gender,
          match_preference: profileForm.match_preference
        })
      });
      if (data.profile) {
        setProfile(data.profile);
        setShowProfileModal(false);
        showToast('Profile and matchmaking preferences saved.');
      }
    } catch (err) {
      setProfileError(err.message || 'Could not update profile.');
    } finally {
      setProfileSaving(false);
    }
  };

  const startLocalMedia = useCallback(async (videoDeviceId = null, audioDeviceId = null) => {
    try {
      setCameraPermissionError(null);
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop());
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera and Microphone access requires a Secure Context (HTTPS or localhost).');
      }

      const constraints = {
        video: videoDeviceId
          ? { deviceId: { exact: videoDeviceId } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: audioDeviceId
          ? { deviceId: { exact: audioDeviceId } }
          : { echoCancellation: true, noiseSuppression: true }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      setLocalStream(stream);
      setIsAudioMuted(false);
      setIsVideoMuted(false);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      return stream;
    } catch (err) {
      setCameraPermissionError(
        err.name === 'NotAllowedError'
          ? 'Camera/Microphone access was denied. Please allow permissions in your browser settings to use VibeRoom.'
          : `Could not access camera/microphone: ${err.message}`
      );
      return null;
    }
  }, []);

  const stopLocalMedia = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    setLocalStream(null);
  }, []);

  const toggleAudio = useCallback(() => {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setIsAudioMuted(!audioTrack.enabled);
    }
  }, []);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      setIsVideoMuted(!videoTrack.enabled);
    }
  }, []);

  const cleanupPeerConnection = useCallback(() => {
    pendingCandidatesRef.current = [];
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
      } catch {
        // Ignore close errors
      }
      pcRef.current = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    activeSessionIdRef.current = null;
    currentPartnerIdRef.current = null;
    setSessionId(null);
    setPartnerId(null);
    setPartnerProfile(null);
    setMatchedCommonTag(null);
    setPartnerInterests([]);
  }, []);

  const sendWsEvent = useCallback((payload) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const flushPendingCandidates = useCallback(async (pc) => {
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
    const queued = pendingCandidatesRef.current.splice(0, pendingCandidatesRef.current.length);
    for (const candidateInit of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch {
        // Ignore candidate error
      }
    }
  }, []);

  const createPeerConnection = useCallback((authoritativeSessionId, matchedPartnerId) => {
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // Ignore close error
      }
    }
    pendingCandidatesRef.current = [];

    const pc = new RTCPeerConnection(rtcConfigRef.current);
    pcRef.current = pc;
    activeSessionIdRef.current = authoritativeSessionId;
    currentPartnerIdRef.current = matchedPartnerId;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    pc.ontrack = (event) => {
      if (activeSessionIdRef.current !== authoritativeSessionId) return;
      if (remoteVideoRef.current && event.streams && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
        setConnectionStatus('connected');
      }
    };

    pc.onicecandidate = (event) => {
      if (activeSessionIdRef.current !== authoritativeSessionId) return;
      if (event.candidate) {
        sendWsEvent({
          type: 'signal',
          sessionId: authoritativeSessionId,
          data: {
            type: 'candidate',
            candidate: event.candidate
          }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (activeSessionIdRef.current !== authoritativeSessionId) return;
      if (pc.connectionState === 'connected') {
        setConnectionStatus('connected');
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setConnectionStatus('partner_disconnected');
      }
    };

    return pc;
  }, [sendWsEvent]);

  const connectSignalingServer = useCallback((overrideUrl = null) => {
    const targetUrl = overrideUrl || wsUrl;
    if (wsRef.current) {
      try {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      } catch {
        // Ignore cleanup error
      }
      wsRef.current = null;
    }

    setServerStatus('connecting');
    setServerError(null);

    let ws;
    try {
      // Do not put access tokens in the WebSocket URL: query strings can end up in
      // proxy/access logs. Authenticate in the first WebSocket message after opening.
      const parsed = new URL(targetUrl);
      ws = new WebSocket(parsed.toString());
      wsRef.current = ws;
    } catch (err) {
      setServerStatus('error');
      setServerError(`Invalid WebSocket URL (${targetUrl}): ${err.message}`);
      return;
    }

    ws.onopen = () => {
      setServerStatus('connected');
      setServerError(null);
      if (authSessionRef.current?.access_token) {
        ws.send(
          JSON.stringify({
            type: 'authenticate',
            token: authSessionRef.current.access_token
          })
        );
      }
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'connected':
        case 'authenticated': {
          if (msg.iceServers && Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
            setRtcConfig({
              iceServers: msg.iceServers,
              iceCandidatePoolSize: 10
            });
          }
          if (msg.profile) {
            setProfile(msg.profile);
          }
          break;
        }

        case 'queued': {
          activeSessionIdRef.current = null;
          currentPartnerIdRef.current = null;
          setSessionId(null);
          setPartnerId(null);
          setPartnerProfile(null);
          setActiveMatchMode(msg.matchMode || matchModeRef.current);
          setConnectionStatus('searching');
          break;
        }

        case 'match_found': {
          const {
            sessionId: matchedSessionId,
            partnerId: matchedPartnerId,
            partnerProfile: remotePublicProfile,
            initiator,
            matchMode: resolvedMode,
            sharedInterests = [],
            partnerInterests: remoteInterests = []
          } = msg;

          if (!matchedSessionId || !matchedPartnerId) break;

          setMessages([]);
          setUnreadCount(0);
          setSessionId(matchedSessionId);
          setPartnerId(matchedPartnerId);
          setPartnerProfile(remotePublicProfile || { display_name: 'Viber' });
          setPartnerInterests(remoteInterests);
          setMatchedCommonTag(sharedInterests[0] || null);
          setActiveMatchMode(resolvedMode || 'random');
          setConnectionStatus('connecting');

          const pc = createPeerConnection(matchedSessionId, matchedPartnerId);

          if (initiator) {
            try {
              const offer = await pc.createOffer();
              if (activeSessionIdRef.current !== matchedSessionId) break;
              await pc.setLocalDescription(offer);
              sendWsEvent({
                type: 'signal',
                sessionId: matchedSessionId,
                data: {
                  type: 'offer',
                  sdp: pc.localDescription
                }
              });
            } catch {
              showToast('WebRTC negotiation error. Skipping to next partner...');
            }
          }
          break;
        }

        case 'signal': {
          if (!msg.sessionId || msg.sessionId !== activeSessionIdRef.current) return;
          const pc = pcRef.current;
          const signalData = msg.data;
          if (!pc || !signalData) return;

          try {
            if (signalData.type === 'offer' && signalData.sdp) {
              await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
              await flushPendingCandidates(pc);
              const answer = await pc.createAnswer();
              if (activeSessionIdRef.current !== msg.sessionId) return;
              await pc.setLocalDescription(answer);
              sendWsEvent({
                type: 'signal',
                sessionId: msg.sessionId,
                data: {
                  type: 'answer',
                  sdp: pc.localDescription
                }
              });
            } else if (signalData.type === 'answer' && signalData.sdp) {
              await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
              await flushPendingCandidates(pc);
            } else if (signalData.type === 'candidate' && signalData.candidate) {
              if (!pc.remoteDescription || !pc.remoteDescription.type) {
                pendingCandidatesRef.current.push(signalData.candidate);
              } else {
                await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
              }
            }
          } catch {
            // Ignore transient signaling error
          }
          break;
        }

        case 'chat_message': {
          if (!msg.sessionId || msg.sessionId !== activeSessionIdRef.current) return;
          const formattedTime = msg.timestamp
            ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          setMessages(prev => [
            ...prev,
            {
              id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
              sender: 'partner',
              text: String(msg.text || '').slice(0, 400),
              timestamp: formattedTime
            }
          ]);

          if (!isMobileChatOpenRef.current) {
            setUnreadCount(c => c + 1);
          }
          break;
        }

        case 'partner_left': {
          if (!msg.sessionId || msg.sessionId !== activeSessionIdRef.current) return;
          cleanupPeerConnection();
          setConnectionStatus('partner_disconnected');
          showToast(msg.reason === 'skipped' ? 'Partner skipped to next chat.' : 'Partner disconnected.');
          break;
        }

        case 'report_ack': {
          if (pendingReportCallbackRef.current) {
            pendingReportCallbackRef.current({ ok: true, reportId: msg.reportId });
            pendingReportCallbackRef.current = null;
          }
          break;
        }

        case 'error': {
          if (msg.code === 'REPORT_ERROR' && pendingReportCallbackRef.current) {
            pendingReportCallbackRef.current({ ok: false, message: msg.message });
            pendingReportCallbackRef.current = null;
          } else if (msg.code === 'INCOMPLETE_GENDER_PROFILE') {
            setConnectionStatus('idle');
            setShowProfileModal(true);
            showToast(msg.message || 'Please set your self-declared gender in Profile Settings to use Gender Preference matching, or switch to Random Chat.');
          } else if (msg.code === 'UNAUTHORIZED') {
            setConnectionStatus('idle');
            setInLobby(true);
            showToast(msg.message || 'Please sign in to join matchmaking.');
          } else {
            showToast(msg.message || 'Signaling error occurred.');
          }
          break;
        }

        default:
          break;
      }
    };

    ws.onerror = () => {
      setServerStatus('error');
      setServerError(
        `Could not connect to WebSocket signaling server at ${targetUrl}. Ensure the Node.js server (npm start) is running.`
      );
    };

    ws.onclose = () => {
      setServerStatus(prev => (prev === 'error' ? 'error' : 'disconnected'));
      if (activeSessionIdRef.current) {
        cleanupPeerConnection();
        setConnectionStatus('error');
      }
    };
  }, [wsUrl, createPeerConnection, flushPendingCandidates, cleanupPeerConnection, sendWsEvent, showToast]);

  useEffect(() => {
    connectSignalingServer(wsUrl);
    return () => {
      if (wsRef.current) wsRef.current.close();
      cleanupPeerConnection();
      stopLocalMedia();
    };
  }, []);

  const startMatchmaking = useCallback((overrideMode = null) => {
    const modeToUse = overrideMode || matchModeRef.current;
    if (overrideMode) {
      setMatchMode(overrideMode);
      matchModeRef.current = overrideMode;
    }

    cleanupPeerConnection();
    setMessages([]);
    setUnreadCount(0);

    if (!authSessionRef.current?.access_token) {
      showToast('Please log in to start video matchmaking.');
      setInLobby(true);
      return;
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setConnectionStatus('error');
      setServerError('Signaling server is not connected. Click "Reconnect Signaling Server" to retry.');
      connectSignalingServer();
      return;
    }

    setConnectionStatus('searching');
    sendWsEvent({
      type: 'join_queue',
      token: authSessionRef.current.access_token,
      matchMode: modeToUse,
      interests: selectedInterestsRef.current
    });
  }, [cleanupPeerConnection, connectSignalingServer, sendWsEvent, showToast]);

  const handleNextPartner = useCallback(() => {
    const previousSessionId = activeSessionIdRef.current;
    cleanupPeerConnection();
    setMessages([]);
    setUnreadCount(0);

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setConnectionStatus('error');
      setServerError('Signaling server disconnected. Reconnect to find a new partner.');
      return;
    }

    setConnectionStatus('searching');
    sendWsEvent({
      type: previousSessionId ? 'next_partner' : 'join_queue',
      token: authSessionRef.current?.access_token,
      sessionId: previousSessionId || undefined,
      matchMode: matchModeRef.current,
      interests: selectedInterestsRef.current
    });
  }, [cleanupPeerConnection, sendWsEvent]);

  const handleLeaveToLobby = useCallback(() => {
    const previousSessionId = activeSessionIdRef.current;
    if (previousSessionId) {
      sendWsEvent({
        type: 'leave_session',
        sessionId: previousSessionId
      });
    } else {
      sendWsEvent({
        type: 'leave_queue'
      });
    }
    cleanupPeerConnection();
    setConnectionStatus('idle');
    setInLobby(true);
    setMessages([]);
    setUnreadCount(0);
  }, [cleanupPeerConnection, sendWsEvent]);

  const handleLogout = async () => {
    handleLeaveToLobby();
    stopLocalMedia();
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore logout network error
    }
    persistAuthSession(null);
    setProfile(null);
    showToast('Signed out of VibeRoom.');
  };

  const handleDeleteAccount = async () => {
    try {
      await apiFetch('/api/account', { method: 'DELETE' });
      handleLeaveToLobby();
      stopLocalMedia();
      persistAuthSession(null);
      setProfile(null);
      setShowDeleteConfirm(false);
      setShowProfileModal(false);
      showToast('Your account and profile have been permanently deleted.');
    } catch (err) {
      setProfileError(err.message || 'Failed to delete account.');
    }
  };

  const blockCurrentPartner = useCallback(async () => {
    const targetPartner = currentPartnerIdRef.current;
    if (!targetPartner) return;
    try {
      await apiFetch('/api/block', {
        method: 'POST',
        body: JSON.stringify({ blockedUserId: targetPartner })
      });
      setBlockedUsers(prev => [...new Set([...prev, targetPartner])]);
      showToast('Partner blocked permanently across your account. Finding someone new...');
    } catch {
      showToast('Partner skipped. (Could not sync block to server).');
    }
    handleNextPartner();
  }, [apiFetch, showToast, handleNextPartner]);

  const handleSubmitReport = async (e) => {
    e?.preventDefault();
    const targetPartner = currentPartnerIdRef.current || partnerId;
    const currentSession = activeSessionIdRef.current || sessionId;

    if (!targetPartner || !currentSession) {
      setReportError('No active session or partner to report.');
      return;
    }

    setIsSubmittingReport(true);
    setReportError(null);

    const payload = {
      sessionId: currentSession,
      reportedUserId: targetPartner,
      reason: selectedReportReason,
      details: reportDetails.trim().slice(0, 500)
    };

    try {
      const result = await apiFetch('/api/report', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!result || !result.reportId) {
        throw new Error('Invalid server response: missing report confirmation ID.');
      }

      setBlockedUsers(prev => [...new Set([...prev, targetPartner])]);
      setIsSubmittingReport(false);
      setShowReportModal(false);
      setReportDetails('');
      showToast(`Report received by server (#${result.reportId}). Partner blocked.`);
      handleNextPartner();
    } catch (httpErr) {
      setIsSubmittingReport(false);
      setReportError(`Report could not be recorded: ${httpErr.message}`);
    }
  };

  const handleSendMessage = (e) => {
    e?.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed) return;

    const currentSession = activeSessionIdRef.current;
    if (!currentSession || connectionStatus !== 'connected') {
      showToast('Wait until you are connected to a partner before chatting.');
      return;
    }

    const now = Date.now();
    if (now - lastMessageTimestamp.current < 400) {
      showToast('You are sending messages too fast. Please wait a moment.');
      return;
    }
    lastMessageTimestamp.current = now;

    const cleanText = trimmed.slice(0, 400);
    const sent = sendWsEvent({
      type: 'chat_message',
      sessionId: currentSession,
      text: cleanText
    });

    if (!sent) {
      showToast('Failed to send message: signaling server disconnected.');
      return;
    }

    setMessages(prev => [
      ...prev,
      {
        id: 'msg_' + now,
        sender: 'you',
        text: cleanText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]);
    setChatInput('');
  };

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, inLobby]);

  const toggleInterest = (tag) => {
    setSelectedInterests(prev =>
      prev.includes(tag)
        ? prev.length > 1
          ? prev.filter(t => t !== tag)
          : prev
        : [...prev, tag]
    );
  };

  const handleApplyServerUrl = (e) => {
    e?.preventDefault();
    const cleaned = wsUrlInput.trim();
    if (!cleaned.startsWith('ws://') && !cleaned.startsWith('wss://')) {
      showToast('Signaling URL must start with ws:// or wss://');
      return;
    }
    try {
      sessionStorage.setItem('viberoom_ws_url', cleaned);
    } catch {
      // Ignore storage error
    }
    setWsUrl(cleaned);
    connectSignalingServer(cleaned);
    showToast(`Reconnecting to ${cleaned}...`);
  };

  const handleStartVibing = async () => {
    if (!authSession?.access_token) {
      showToast('Please sign in to your account before entering VibeRoom.');
      return;
    }
    if (!ageConfirmed) {
      showToast('You must confirm you are 18+ to enter VibeRoom.');
      return;
    }
    if (
      matchMode === 'gender_preference' &&
      (!profile?.gender || profile.gender === 'prefer_not_to_say')
    ) {
      setShowProfileModal(true);
      showToast(
        'To use Match by Gender Preference, please set your self-declared gender in Profile Settings, or select Random Chat.'
      );
      return;
    }

    const stream = await startLocalMedia();
    if (stream) {
      setInLobby(false);
      startMatchmaking(matchMode);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col justify-between selection:bg-fuchsia-500 selection:text-white font-sans">
      {inLobby ? (
        <>
          {/* Top Navigation Bar */}
          <header className="border-b border-neutral-800/80 backdrop-blur-md bg-neutral-950/70 sticky top-0 z-40 px-6 py-4 flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-fuchsia-600 to-cyan-500 flex items-center justify-center shadow-lg shadow-fuchsia-500/20">
                <Sparkles className="w-6 h-6 text-white animate-pulse" />
              </div>
              <div>
                <span className="text-2xl font-black tracking-tight bg-gradient-to-r from-white via-neutral-200 to-neutral-400 bg-clip-text text-transparent">
                  VIBE<span className="text-transparent bg-clip-text bg-gradient-to-r from-fuchsia-400 to-cyan-400">ROOM</span>
                </span>
                <span className="ml-2 text-xs uppercase px-2 py-0.5 rounded-full bg-fuchsia-500/10 text-fuchsia-400 border border-fuchsia-500/20 font-semibold tracking-wider">
                  2.0 Auth & Match
                </span>
              </div>
            </div>

            <div className="flex items-center space-x-2.5">
              {/* Signaling Server Status Pill */}
              <button
                onClick={() => setShowServerConfig(prev => !prev)}
                className={`flex items-center space-x-2 text-xs px-3 py-1.5 rounded-lg border transition ${
                  serverStatus === 'connected'
                    ? 'bg-emerald-950/50 border-emerald-800/60 text-emerald-300 hover:bg-emerald-950'
                    : serverStatus === 'connecting'
                    ? 'bg-amber-950/50 border-amber-800/60 text-amber-300'
                    : 'bg-red-950/60 border-red-800/70 text-red-300 hover:bg-red-900/50'
                }`}
                title="Configure WebSocket Signaling Server"
              >
                {serverStatus === 'connected' ? (
                  <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <WifiOff className="w-3.5 h-3.5 text-red-400" />
                )}
                <span className="hidden sm:inline">
                  {serverStatus === 'connected'
                    ? 'Signaling Online'
                    : serverStatus === 'connecting'
                    ? 'Connecting...'
                    : 'Signaling Offline'}
                </span>
                <Sliders className="w-3 h-3 opacity-75" />
              </button>

              {authSession && (
                <>
                  <button
                    onClick={() => setShowProfileModal(true)}
                    className="flex items-center space-x-2 text-xs px-3 py-1.5 rounded-lg border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 transition"
                  >
                    <User className="w-3.5 h-3.5 text-fuchsia-400" />
                    <span>{profile?.display_name || 'Profile'}</span>
                  </button>
                  <button
                    onClick={handleLogout}
                    className="flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-neutral-800 bg-neutral-900/60 hover:bg-red-950/50 hover:border-red-800/60 text-neutral-400 hover:text-red-300 transition"
                    title="Sign Out"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Logout</span>
                  </button>
                </>
              )}

              <button
                onClick={() => setShowGuidelines(true)}
                className="flex items-center space-x-2 text-xs text-neutral-400 hover:text-white transition px-3 py-1.5 rounded-lg border border-neutral-800 hover:border-neutral-700 bg-neutral-900/60"
              >
                <ShieldAlert className="w-4 h-4 text-cyan-400" />
                <span className="hidden sm:inline">Safety & Rules</span>
              </button>
            </div>
          </header>

          {/* Collapsible Signaling Server Configuration Bar */}
          {showServerConfig && (
            <div className="bg-neutral-900/95 border-b border-neutral-800 px-6 py-3.5">
              <form onSubmit={handleApplyServerUrl} className="max-w-5xl mx-auto flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="flex items-center space-x-2 text-xs text-neutral-300">
                  <Server className="w-4 h-4 text-cyan-400 flex-shrink-0" />
                  <span>Signaling WebSocket URL:</span>
                </div>
                <div className="flex-1 flex items-center space-x-2 max-w-xl">
                  <input
                    type="text"
                    value={wsUrlInput}
                    onChange={(e) => setWsUrlInput(e.target.value)}
                    placeholder="ws://localhost:8080/ws or wss://your-domain.com/ws"
                    className="flex-1 bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-cyan-500"
                  />
                  <button
                    type="submit"
                    className="px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold transition flex items-center space-x-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Connect</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Main Lobby Content */}
          <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-10 flex flex-col lg:flex-row items-start gap-10 justify-between">
            {/* Left Column: Hero + Protected Auth Gate or Matchmaking Controls */}
            <div className="flex-1 space-y-6 text-left w-full">
              <div className="inline-flex items-center space-x-2 text-xs font-semibold px-3 py-1 rounded-full bg-cyan-950/60 border border-cyan-800/60 text-cyan-300">
                <span className={`w-2 h-2 rounded-full ${serverStatus === 'connected' ? 'bg-cyan-400 animate-ping' : 'bg-amber-400'}`} />
                <span>Authenticated P2P Video & Mutual Preference Matchmaking</span>
              </div>

              <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-tight">
                Meet real people. <br />
                <span className="bg-gradient-to-r from-fuchsia-400 via-pink-400 to-cyan-400 bg-clip-text text-transparent">
                  Verified accounts, spontaneous vibes.
                </span>
              </h1>

              {!authSession ? (
                <div className="bg-neutral-900/90 border border-neutral-800 rounded-2xl p-6 max-w-md shadow-2xl space-y-4">
                  <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                    <div className="flex items-center space-x-2">
                      <Lock className="w-4 h-4 text-fuchsia-400" />
                      <h2 className="font-bold text-sm text-white">
                        {authView === 'login'
                          ? 'Sign In to VibeRoom'
                          : authView === 'register'
                          ? 'Create Your Account'
                          : 'Reset Password'}
                      </h2>
                    </div>
                    <div className="flex space-x-1 text-xs">
                      <button
                        type="button"
                        onClick={() => { setAuthView('login'); setAuthError(null); setAuthNotice(null); }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition ${
                          authView === 'login' ? 'bg-fuchsia-600/20 text-fuchsia-300 border border-fuchsia-500/40' : 'text-neutral-400 hover:text-white'
                        }`}
                      >
                        Login
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAuthView('register'); setAuthError(null); setAuthNotice(null); }}
                        className={`px-2.5 py-1 rounded-lg font-medium transition ${
                          authView === 'register' ? 'bg-fuchsia-600/20 text-fuchsia-300 border border-fuchsia-500/40' : 'text-neutral-400 hover:text-white'
                        }`}
                      >
                        Register
                      </button>
                    </div>
                  </div>

                  <p className="text-xs text-neutral-400">
                    Protected access: Guests cannot join matchmaking. Your email is never shown to other users.
                  </p>

                  {authError && (
                    <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200 flex items-start space-x-2">
                      <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                      <span>{authError}</span>
                    </div>
                  )}

                  {authNotice && (
                    <div className="p-3 rounded-xl bg-emerald-950/70 border border-emerald-800 text-xs text-emerald-200 flex items-start space-x-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                      <span>{authNotice}</span>
                    </div>
                  )}

                  <form onSubmit={handleAuthSubmit} className="space-y-3">
                    {authView === 'register' && (
                      <div>
                        <label className="block text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
                          Display Name (Public)
                        </label>
                        <div className="relative">
                          <User className="w-4 h-4 text-neutral-500 absolute left-3 top-2.5" />
                          <input
                            type="text"
                            required
                            minLength={2}
                            maxLength={32}
                            value={authDisplayName}
                            onChange={(e) => setAuthDisplayName(e.target.value)}
                            placeholder="e.g. AlexVibes"
                            className="w-full bg-neutral-950 border border-neutral-700 rounded-xl pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-500"
                          />
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="block text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
                        Email Address (Private)
                      </label>
                      <div className="relative">
                        <Mail className="w-4 h-4 text-neutral-500 absolute left-3 top-2.5" />
                        <input
                          type="email"
                          required
                          value={authEmail}
                          onChange={(e) => setAuthEmail(e.target.value)}
                          placeholder="you@example.com"
                          className="w-full bg-neutral-950 border border-neutral-700 rounded-xl pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-500"
                        />
                      </div>
                    </div>

                    {authView !== 'reset' && (
                      <div>
                        <label className="block text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
                          Password
                        </label>
                        <div className="relative">
                          <KeyRound className="w-4 h-4 text-neutral-500 absolute left-3 top-2.5" />
                          <input
                            type="password"
                            required
                            minLength={6}
                            value={authPassword}
                            onChange={(e) => setAuthPassword(e.target.value)}
                            placeholder="At least 6 characters"
                            className="w-full bg-neutral-950 border border-neutral-700 rounded-xl pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-500"
                          />
                        </div>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 hover:from-fuchsia-500 hover:to-cyan-500 text-white font-bold text-xs shadow-lg transition flex items-center justify-center space-x-2 disabled:opacity-50"
                    >
                      {authLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                      <span>
                        {authView === 'login'
                          ? 'Sign In'
                          : authView === 'register'
                          ? 'Create Account'
                          : 'Send Reset Link'}
                      </span>
                    </button>
                  </form>

                  <div className="flex items-center justify-between pt-2 border-t border-neutral-800 text-xs">
                    {authView !== 'reset' ? (
                      <button
                        type="button"
                        onClick={() => { setAuthView('reset'); setAuthError(null); setAuthNotice(null); }}
                        className="text-neutral-400 hover:text-cyan-400 transition"
                      >
                        Forgot password?
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setAuthView('login'); setAuthError(null); setAuthNotice(null); }}
                        className="text-neutral-400 hover:text-cyan-400 transition"
                      >
                        Back to Sign In
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={handleGoogleOAuth}
                      className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700 font-medium transition"
                    >
                      Continue with Google
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Profile Banner */}
                  <div className="p-4 rounded-2xl bg-neutral-900/90 border border-neutral-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-fuchsia-600 to-cyan-500 flex items-center justify-center font-bold text-sm text-white">
                        {(profile?.display_name || 'V')[0].toUpperCase()}
                      </div>
                      <div>
                        <div className="flex items-center space-x-2">
                          <span className="font-bold text-sm text-white">
                            {profile?.display_name || 'Viber'}
                          </span>
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-800/60 text-emerald-300">
                            Authenticated
                          </span>
                        </div>
                        <p className="text-xs text-neutral-400">
                          Self-declared gender:{' '}
                          <strong className="text-neutral-200">
                            {GENDER_OPTIONS.find(g => g.id === profile?.gender)?.label || 'Not set'}
                          </strong>{' '}
                          • Preference:{' '}
                          <strong className="text-cyan-300">
                            {MATCH_PREFERENCE_OPTIONS.find(p => p.id === profile?.match_preference)?.label || 'Anyone'}
                          </strong>
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowProfileModal(true)}
                      className="text-xs px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-cyan-300 border border-neutral-700 font-semibold transition"
                    >
                      Edit Profile & Preferences
                    </button>
                  </div>

                  {/* Matching Mode Selector: Random Chat vs Match by Gender Preference */}
                  <div className="space-y-2.5">
                    <label className="text-xs uppercase tracking-wider font-semibold text-neutral-400 flex items-center space-x-2">
                      <Users className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Choose Matchmaking Mode</span>
                    </label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setMatchMode('random')}
                        className={`p-4 rounded-2xl border text-left transition-all ${
                          matchMode === 'random'
                            ? 'bg-cyan-950/40 border-cyan-500/80 shadow-md shadow-cyan-500/10'
                            : 'bg-neutral-900/70 border-neutral-800 hover:border-neutral-700'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-sm text-white flex items-center space-x-2">
                            <Shuffle className="w-4 h-4 text-cyan-400" />
                            <span>1. Random Chat</span>
                          </span>
                          {matchMode === 'random' && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-semibold">
                              Selected
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-neutral-400">
                          Fastest pairing with anyone online, prioritizing shared interest tags.
                        </p>
                      </button>

                      <button
                        type="button"
                        onClick={() => setMatchMode('gender_preference')}
                        className={`p-4 rounded-2xl border text-left transition-all ${
                          matchMode === 'gender_preference'
                            ? 'bg-fuchsia-950/40 border-fuchsia-500/80 shadow-md shadow-fuchsia-500/10'
                            : 'bg-neutral-900/70 border-neutral-800 hover:border-neutral-700'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-bold text-sm text-white flex items-center space-x-2">
                            <HeartHandshake className="w-4 h-4 text-fuchsia-400" />
                            <span>2. Match by Gender Preference</span>
                          </span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-fuchsia-500/20 text-fuchsia-300 font-semibold">
                            Free in Beta
                          </span>
                        </div>
                        <p className="text-xs text-neutral-400">
                          Pairs you only when both users&apos; stored preferences mutually include each other&apos;s declared gender.
                        </p>
                      </button>
                    </div>
                  </div>

                  {/* Interest Tags Selector */}
                  <div className="space-y-2.5">
                    <label className="text-xs uppercase tracking-wider font-semibold text-neutral-400 flex items-center space-x-2">
                      <Tag className="w-3.5 h-3.5 text-fuchsia-400" />
                      <span>Select Your Interests (Matchmaking Priority)</span>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {INTEREST_TAGS.map(tag => {
                        const isSelected = selectedInterests.includes(tag);
                        return (
                          <button
                            key={tag}
                            onClick={() => toggleInterest(tag)}
                            className={`text-xs px-3.5 py-1.5 rounded-lg font-medium transition-all duration-200 border ${
                              isSelected
                                ? 'bg-fuchsia-600/20 border-fuchsia-500/80 text-fuchsia-200 shadow-sm shadow-fuchsia-500/30'
                                : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200'
                            }`}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 18+ Age Disclaimer & Start Action */}
                  <div className="pt-3 border-t border-neutral-800/80 space-y-4">
                    <label className="flex items-start space-x-3 cursor-pointer group">
                      <input
                        type="checkbox"
                        checked={ageConfirmed}
                        onChange={(e) => setAgeConfirmed(e.target.checked)}
                        className="mt-1 w-4 h-4 rounded bg-neutral-900 border-neutral-700 text-fuchsia-500 focus:ring-fuchsia-500 cursor-pointer accent-fuchsia-500"
                      />
                      <span className="text-xs text-neutral-400 group-hover:text-neutral-300 transition select-none">
                        I certify that I am at least <strong>18 years old</strong> and agree to the{' '}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setShowGuidelines(true); }}
                          className="text-cyan-400 underline hover:text-cyan-300"
                        >
                          Community Code of Conduct
                        </button>
                        . Note: A self-declared age checkbox is not verified age assurance.
                      </span>
                    </label>

                    <button
                      onClick={handleStartVibing}
                      disabled={!ageConfirmed}
                      className={`w-full py-4 px-6 rounded-2xl font-bold text-lg flex items-center justify-center space-x-3 shadow-xl transition-all duration-300 transform active:scale-95 ${
                        ageConfirmed
                          ? 'bg-gradient-to-r from-fuchsia-600 to-cyan-600 hover:from-fuchsia-500 hover:to-cyan-500 text-white shadow-fuchsia-500/25 cursor-pointer'
                          : 'bg-neutral-800/80 text-neutral-500 cursor-not-allowed border border-neutral-700/40'
                      }`}
                    >
                      <span>
                        Enter Room ({matchMode === 'gender_preference' ? 'Gender Preference Match' : 'Random Chat'})
                      </span>
                      <ChevronRight className="w-5 h-5" />
                    </button>
                  </div>

                  {cameraPermissionError && (
                    <div className="p-3.5 bg-red-950/60 border border-red-800/80 rounded-xl text-red-300 text-xs flex items-start space-x-3">
                      <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                      <span>{cameraPermissionError}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Right Column: Live Cam Check Card */}
            <div className="w-full lg:w-96 flex flex-col items-center">
              <div className="w-full aspect-[4/3] rounded-3xl bg-neutral-900 border border-neutral-800 relative overflow-hidden shadow-2xl flex items-center justify-center">
                {localStream ? (
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover transform -scale-x-100 ${isVideoMuted ? 'hidden' : 'block'}`}
                  />
                ) : (
                  <div className="text-center p-6 space-y-3">
                    <div className="w-16 h-16 rounded-2xl bg-neutral-800/80 flex items-center justify-center mx-auto text-neutral-500">
                      <Camera className="w-8 h-8" />
                    </div>
                    <p className="text-xs text-neutral-400 font-medium">
                      Camera preview inactive.<br />Will initialize upon entering room.
                    </p>
                    <button
                      type="button"
                      onClick={() => startLocalMedia()}
                      className="text-xs px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-cyan-300 border border-neutral-700 transition"
                    >
                      Test Camera Preview
                    </button>
                  </div>
                )}

                {isVideoMuted && localStream && (
                  <div className="absolute inset-0 bg-neutral-900 flex flex-col items-center justify-center text-neutral-500 space-y-2">
                    <EyeOff className="w-10 h-10" />
                    <span className="text-xs">Camera is Off</span>
                  </div>
                )}

                <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/10 text-[11px] font-semibold text-neutral-300 flex items-center space-x-1.5">
                  <span className={`w-2 h-2 rounded-full ${localStream ? 'bg-emerald-400' : 'bg-neutral-500'}`} />
                  <span>{localStream ? 'Webcam Active' : 'Webcam Standby'}</span>
                </div>
              </div>

              <div className="mt-4 flex items-center space-x-4 text-xs text-neutral-500">
                <span>🔒 Supabase JWT Verified</span>
                <span>•</span>
                <span>🚫 Zero Default Recording</span>
              </div>
            </div>
          </main>

          <footer className="border-t border-neutral-900 px-6 py-4 text-center text-xs text-neutral-500">
            VibeRoom 2.0 © {new Date().getFullYear()} — Authenticated WebRTC video chat. For adults 18+ only.
          </footer>
        </>
      ) : (
        <div className="h-screen w-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-hidden font-sans select-none">
          {/* Top Bar Status */}
          <header className="h-14 border-b border-neutral-800 bg-neutral-900/80 backdrop-blur-md px-4 flex items-center justify-between z-20">
            <div className="flex items-center space-x-3">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-fuchsia-600 to-cyan-500 flex items-center justify-center shadow-md">
                <Sparkles className="w-4 h-4 text-white" />
              </div>
              <span className="font-black text-lg tracking-tight hidden sm:inline">
                VIBE<span className="text-cyan-400">ROOM</span>
              </span>

              <div className="flex items-center space-x-2 bg-neutral-800/80 px-3 py-1 rounded-full border border-neutral-700/60 text-xs">
                <span className={`w-2 h-2 rounded-full ${
                  connectionStatus === 'connected' ? 'bg-emerald-400 animate-pulse' :
                  connectionStatus === 'connecting' ? 'bg-amber-400 animate-ping' :
                  connectionStatus === 'searching' ? 'bg-cyan-400 animate-bounce' : 'bg-red-400'
                }`} />
                <span className="font-medium text-neutral-300">
                  {connectionStatus === 'connected'
                    ? `Connected with ${partnerProfile?.display_name || 'Viber'}`
                    : connectionStatus === 'connecting'
                    ? 'Handshaking...'
                    : connectionStatus === 'searching'
                    ? activeMatchMode === 'gender_preference'
                      ? 'Searching (Gender Preference)...'
                      : 'Searching (Random Queue)...'
                    : connectionStatus === 'partner_disconnected'
                    ? 'Partner Left'
                    : 'Standby'}
                </span>
              </div>

              {matchedCommonTag && connectionStatus === 'connected' && (
                <span className="hidden md:inline-flex items-center space-x-1 text-xs bg-fuchsia-950/70 border border-fuchsia-800/60 text-fuchsia-300 px-2.5 py-0.5 rounded-full font-medium">
                  <Tag className="w-3 h-3 text-fuchsia-400" />
                  <span>Shared: {matchedCommonTag}</span>
                </span>
              )}
            </div>

            <div className="flex items-center space-x-2">
              {(connectionStatus === 'connected' || connectionStatus === 'connecting') && partnerId && (
                <>
                  <button
                    onClick={() => {
                      setReportError(null);
                      setShowReportModal(true);
                    }}
                    className="flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-neutral-800/90 text-neutral-300 hover:text-red-400 border border-neutral-700/60 transition"
                  >
                    <Flag className="w-3.5 h-3.5 text-red-400" />
                    <span className="hidden sm:inline">Report</span>
                  </button>
                  <button
                    onClick={blockCurrentPartner}
                    className="flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-neutral-800/90 text-neutral-300 hover:text-amber-400 border border-neutral-700/60 transition"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                    <span className="hidden sm:inline">Block</span>
                  </button>
                </>
              )}

              <button
                onClick={() => {
                  setIsMobileChatOpen(!isMobileChatOpen);
                  setUnreadCount(0);
                }}
                className="md:hidden relative p-2 rounded-lg bg-neutral-800 text-neutral-300 hover:text-white"
              >
                <MessageSquare className="w-5 h-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-fuchsia-500 text-white rounded-full text-[10px] w-4 h-4 flex items-center justify-center font-bold">
                    {unreadCount}
                  </span>
                )}
              </button>

              <button
                onClick={handleLeaveToLobby}
                className="flex items-center space-x-1 text-xs px-3 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-800/60 transition"
              >
                <PhoneOff className="w-3.5 h-3.5" />
                <span>Leave</span>
              </button>
            </div>
          </header>

          {/* Main Workspace */}
          <div className="flex-1 flex overflow-hidden relative">
            <div className="flex-1 bg-black flex flex-col justify-between p-3 sm:p-4 relative overflow-hidden">
              <div className="relative w-full h-full rounded-2xl sm:rounded-3xl bg-neutral-900 border border-neutral-800 overflow-hidden flex items-center justify-center shadow-inner">
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className={`w-full h-full object-cover ${connectionStatus === 'connected' ? 'block' : 'hidden'}`}
                />

                {connectionStatus !== 'connected' && (
                  <div className="flex flex-col items-center justify-center text-center p-6 space-y-4 max-w-md">
                    {connectionStatus === 'searching' && (
                      <>
                        <div className="w-20 h-20 rounded-full border-4 border-fuchsia-500/20 border-t-fuchsia-500 animate-spin flex items-center justify-center">
                          <Sparkles className="w-8 h-8 text-fuchsia-400" />
                        </div>
                        <div className="space-y-1.5">
                          <h3 className="text-lg font-bold text-white">
                            {activeMatchMode === 'gender_preference'
                              ? 'Searching for a mutually compatible match...'
                              : 'Searching random queue for a partner...'}
                          </h3>
                          <p className="text-xs text-neutral-400">
                            {activeMatchMode === 'gender_preference'
                              ? 'Matching based on your authoritative PostgreSQL gender preferences.'
                              : `Prioritizing interests: ${selectedInterests.slice(0, 3).join(', ')}`}
                          </p>
                        </div>

                        {activeMatchMode === 'gender_preference' && (
                          <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
                            <button
                              type="button"
                              onClick={() => startMatchmaking('random')}
                              className="px-4 py-2 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-bold transition flex items-center space-x-1.5"
                            >
                              <Shuffle className="w-3.5 h-3.5" />
                              <span>Switch to Random Chat</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleLeaveToLobby}
                              className="px-3.5 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-semibold transition"
                            >
                              Cancel Search
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {connectionStatus === 'connecting' && (
                      <div className="space-y-3">
                        <RefreshCw className="w-12 h-12 text-cyan-400 animate-spin mx-auto" />
                        <h3 className="text-lg font-bold text-white">
                          Matched with {partnerProfile?.display_name || 'Viber'}!
                        </h3>
                        <p className="text-xs text-neutral-400">
                          Exchanging WebRTC SDP & ICE candidates (Session: {sessionId})...
                        </p>
                      </div>
                    )}

                    {connectionStatus === 'partner_disconnected' && (
                      <div className="space-y-4">
                        <div className="w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center mx-auto text-neutral-400">
                          <PhoneOff className="w-8 h-8 text-red-400" />
                        </div>
                        <div>
                          <h3 className="text-base font-bold text-white">Partner disconnected.</h3>
                          <p className="text-xs text-neutral-400">Ready to match with the next available person?</p>
                        </div>
                        <button
                          onClick={() => startMatchmaking()}
                          className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 font-bold text-xs text-white shadow-lg"
                        >
                          Find New Partner
                        </button>
                      </div>
                    )}

                    {connectionStatus === 'error' && (
                      <div className="space-y-4">
                        <div className="w-16 h-16 rounded-full bg-red-950/70 border border-red-800/60 flex items-center justify-center mx-auto text-red-400">
                          <WifiOff className="w-8 h-8" />
                        </div>
                        <h3 className="text-base font-bold text-white">Signaling Server Unreachable</h3>
                        <p className="text-xs text-neutral-400">{serverError || `Lost connection to ${wsUrl}.`}</p>
                        <button
                          onClick={() => connectSignalingServer()}
                          className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 font-bold text-xs text-white shadow-lg"
                        >
                          Reconnect Signaling Server
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Local Webcam Picture-in-Picture */}
                <div className="absolute top-4 right-4 w-32 sm:w-48 aspect-[4/3] rounded-xl sm:rounded-2xl bg-neutral-900 border-2 border-neutral-700/80 overflow-hidden shadow-2xl z-10">
                  <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`w-full h-full object-cover transform -scale-x-100 ${isVideoMuted ? 'hidden' : 'block'}`}
                  />
                  {isVideoMuted && (
                    <div className="w-full h-full flex flex-col items-center justify-center bg-neutral-900 text-neutral-500 text-[10px]">
                      <EyeOff className="w-6 h-6 mb-1" />
                      <span>Cam Off</span>
                    </div>
                  )}
                  <div className="absolute bottom-1.5 left-2 text-[10px] font-bold text-white/90 bg-black/60 px-2 py-0.5 rounded-md">
                    {profile?.display_name || 'You'} {isAudioMuted && '(Muted)'}
                  </div>
                </div>
              </div>

              {/* Bottom Floating Control Hub */}
              <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 flex items-center space-x-3 bg-neutral-900/90 backdrop-blur-xl border border-neutral-800 px-5 py-3 rounded-full shadow-2xl z-20">
                <button
                  onClick={toggleAudio}
                  className={`p-3 rounded-full transition ${
                    isAudioMuted
                      ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                      : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700 border border-neutral-700'
                  }`}
                >
                  {isAudioMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>

                <button
                  onClick={toggleVideo}
                  className={`p-3 rounded-full transition ${
                    isVideoMuted
                      ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                      : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700 border border-neutral-700'
                  }`}
                >
                  {isVideoMuted ? <CameraOff className="w-5 h-5" /> : <Camera className="w-5 h-5" />}
                </button>

                <button
                  onClick={handleNextPartner}
                  className="flex items-center space-x-2 px-6 py-3 rounded-full bg-gradient-to-r from-fuchsia-600 to-cyan-500 hover:from-fuchsia-500 hover:to-cyan-400 text-white font-extrabold text-sm shadow-lg active:scale-95 transition-all"
                >
                  <span>Next Partner</span>
                  <SkipForward className="w-4 h-4 fill-current" />
                </button>
              </div>
            </div>

            {/* Right Side: Real-time Text Chat Pane */}
            <aside className={`
              fixed md:relative inset-y-0 right-0 z-30 w-full sm:w-80 md:w-88 lg:w-96
              bg-neutral-900/95 md:bg-neutral-900 border-l border-neutral-800 flex flex-col
              transition-transform duration-300 ease-in-out
              ${isMobileChatOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}
            `}>
              <div className="p-3.5 border-b border-neutral-800 flex items-center justify-between bg-neutral-950/40">
                <div className="flex items-center space-x-2">
                  <MessageSquare className="w-4 h-4 text-fuchsia-400" />
                  <h2 className="font-bold text-sm text-neutral-200">Room Chat</h2>
                  {sessionId && (
                    <span className="text-[10px] font-mono text-neutral-500">
                      #{sessionId.slice(0, 10)}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setIsMobileChatOpen(false)}
                  className="md:hidden text-neutral-400 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center text-neutral-500 space-y-2 p-4">
                    <Sparkles className="w-6 h-6 text-neutral-600" />
                    <p className="text-xs">
                      {connectionStatus === 'connected'
                        ? `Connected with ${partnerProfile?.display_name || 'your partner'}! Say hi.`
                        : 'Messages are scoped to your active match and cleared when switching partners.'}
                    </p>
                  </div>
                ) : (
                  messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex flex-col ${m.sender === 'you' ? 'items-end' : 'items-start'}`}
                    >
                      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed break-words ${
                        m.sender === 'you'
                          ? 'bg-gradient-to-r from-fuchsia-600 to-fuchsia-700 text-white rounded-br-none'
                          : 'bg-neutral-800 border border-neutral-700/70 text-neutral-200 rounded-bl-none'
                      }`}>
                        {m.text}
                      </div>
                      <span className="text-[10px] text-neutral-500 mt-1 px-1">
                        {m.timestamp}
                      </span>
                    </div>
                  ))
                )}
                <div ref={chatBottomRef} />
              </div>

              <form onSubmit={handleSendMessage} className="p-3 border-t border-neutral-800 bg-neutral-950/60 flex items-center space-x-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={connectionStatus === 'connected' ? 'Type a friendly message...' : 'Connect with someone to chat...'}
                  disabled={connectionStatus !== 'connected'}
                  maxLength={400}
                  className="flex-1 bg-neutral-900 border border-neutral-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-fuchsia-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={connectionStatus !== 'connected' || !chatInput.trim()}
                  className="p-2.5 bg-fuchsia-600 hover:bg-fuchsia-500 disabled:bg-neutral-800 text-white rounded-xl transition disabled:text-neutral-500"
                >
                  <Send className="w-4 h-4" />
                </button>
              </form>
            </aside>
          </div>
        </div>
      )}

      {}
      {showProfileModal && authSession && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 max-w-md w-full rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center space-x-2">
                <User className="w-5 h-5 text-fuchsia-400" />
                <h3 className="font-bold text-white text-base">Your Profile & Match Preferences</h3>
              </div>
              <button onClick={() => setShowProfileModal(false)} className="text-neutral-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3 rounded-xl bg-neutral-950 border border-neutral-800 text-xs text-neutral-400 flex items-start space-x-2">
              <Info className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
              <span>
                <strong>Why we ask for gender preferences:</strong> Self-declared gender is optional and never inferred from your camera, voice, or name. It is stored securely in PostgreSQL and used strictly on the server when you choose <em>Match by Gender Preference</em>. Your email and gender are never disclosed to your chat partner.
              </span>
            </div>

            {profileError && (
              <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200">
                {profileError}
              </div>
            )}

            <form onSubmit={handleSaveProfile} className="space-y-3.5">
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
                  Display Name (2–32 chars)
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={32}
                  value={profileForm.display_name}
                  onChange={(e) => setProfileForm(prev => ({ ...prev, display_name: e.target.value }))}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-500"
                />
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
                  Avatar URL (Optional)
                </label>
                <input
                  type="url"
                  value={profileForm.avatar_url}
                  onChange={(e) => setProfileForm(prev => ({ ...prev, avatar_url: e.target.value }))}
                  placeholder="https://example.com/avatar.png"
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-500"
                />
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
                  Self-Declared Gender (Optional)
                </label>
                <select
                  value={profileForm.gender}
                  onChange={(e) => setProfileForm(prev => ({ ...prev, gender: e.target.value }))}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-500"
                >
                  {GENDER_OPTIONS.map(opt => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] uppercase tracking-wider text-neutral-400 font-semibold mb-1">
                  Match Preference (For Gender-Preference Mode)
                </label>
                <select
                  value={profileForm.match_preference}
                  onChange={(e) => setProfileForm(prev => ({ ...prev, match_preference: e.target.value }))}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-fuchsia-500"
                >
                  {MATCH_PREFERENCE_OPTIONS.map(opt => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="flex items-center space-x-1 text-xs text-red-400 hover:text-red-300 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Account</span>
                </button>

                <button
                  type="submit"
                  disabled={profileSaving}
                  className="px-5 py-2 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 text-white text-xs font-bold shadow-lg disabled:opacity-50"
                >
                  {profileSaving ? 'Saving...' : 'Save Preferences'}
                </button>
              </div>
            </form>

            {showDeleteConfirm && (
              <div className="p-3.5 rounded-xl bg-red-950/80 border border-red-800 space-y-2.5">
                <p className="text-xs text-red-200 font-medium">
                  Permanently delete your account, profile, and blocklist? Safety reports are retained for 90 days for moderation auditing.
                </p>
                <div className="flex justify-end space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-1.5 rounded-lg bg-neutral-800 text-neutral-300 text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDeleteAccount}
                    className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold"
                  >
                    Confirm Permanent Deletion
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Rules & Privacy Modal */}
      {showGuidelines && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-800 max-w-md w-full rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center space-x-2">
                <ShieldAlert className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-white text-base">Community Standards & Privacy</h3>
              </div>
              <button onClick={() => setShowGuidelines(false)} className="text-neutral-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>
            <ul className="text-xs text-neutral-300 space-y-2.5 list-disc pl-5">
              <li><strong>Strictly 18+:</strong> Minors are strictly prohibited. Self-attestation does not verify age; report suspected minors immediately.</li>
              <li><strong>Zero Tolerance for Nudity or Harassment:</strong> Explicit content, harassment, or hate speech results in immediate moderation action.</li>
              <li><strong>Privacy & Gender Preferences:</strong> Your email address and self-declared gender are never publicly exposed to partners. Video and audio streams flow peer-to-peer via WebRTC and are not recorded by default.</li>
              <li><strong>Safety Report Retention:</strong> Submitted safety reports are private to moderation and retained for 90 days.</li>
            </ul>
            <button
              onClick={() => setShowGuidelines(false)}
              className="w-full py-2.5 bg-neutral-800 hover:bg-neutral-700 text-white rounded-xl text-xs font-semibold transition"
            >
              I Understand and Agree
            </button>
          </div>
        </div>
      )}

      {/* Backend-Verified Report Modal */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleSubmitReport} className="bg-neutral-900 border border-neutral-800 max-w-md w-full rounded-2xl p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center space-x-2">
                <Flag className="w-4 h-4 text-red-400" />
                <h3 className="font-bold text-white text-sm">Report Partner to Server</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowReportModal(false)}
                className="text-neutral-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              {REPORT_REASONS.map((r) => (
                <label
                  key={r.id}
                  className={`flex items-center space-x-2.5 px-3 py-2 rounded-xl text-xs border cursor-pointer transition ${
                    selectedReportReason === r.id
                      ? 'bg-red-950/40 border-red-700/80 text-red-200'
                      : 'bg-neutral-800/70 border-neutral-700/60 text-neutral-300 hover:bg-neutral-800'
                  }`}
                >
                  <input
                    type="radio"
                    name="reportReason"
                    value={r.id}
                    checked={selectedReportReason === r.id}
                    onChange={() => setSelectedReportReason(r.id)}
                    className="accent-red-500"
                  />
                  <span>{r.label}</span>
                </label>
              ))}
            </div>

            <textarea
              value={reportDetails}
              onChange={(e) => setReportDetails(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="Additional context (optional)..."
              className="w-full bg-neutral-950 border border-neutral-700 rounded-xl p-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-red-500"
            />

            {reportError && (
              <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200">
                {reportError}
              </div>
            )}

            <div className="flex items-center justify-end space-x-2 pt-2">
              <button
                type="submit"
                disabled={isSubmittingReport}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:bg-neutral-800 text-white text-xs font-bold transition flex items-center space-x-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{isSubmittingReport ? 'Submitting...' : 'Submit Report & Block'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 transform -translate-x-1/2 z-50 bg-neutral-900/95 border border-fuchsia-500/50 text-white text-xs px-4 py-2.5 rounded-full shadow-2xl backdrop-blur-md flex items-center space-x-2">
          <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}