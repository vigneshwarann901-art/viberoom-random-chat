import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Camera, CameraOff, Mic, MicOff, SkipForward, PhoneOff, 
  Flag, ShieldAlert, Send, Sparkles, Tag, 
  AlertTriangle, RefreshCw, Sliders, MessageSquare, 
  CheckCircle2, ChevronRight, X, EyeOff, Wifi, WifiOff, Server
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

const REPORT_REASONS = [
  { id: 'inappropriate', label: 'Inappropriate or NSFW Behavior' },
  { id: 'underage', label: 'Suspected Underage (< 18)' },
  { id: 'harassment', label: 'Harassment or Hate Speech' },
  { id: 'spam', label: 'Commercial Spam or Botting' },
  { id: 'violence', label: 'Violence or Dangerous Acts' }
];

/**
 * Resolve default WebSocket Signaling URL dynamically:
 * 1. Explicit window.VITE_WS_URL or process.env.VITE_WS_URL override if present
 * 2. Saved override in sessionStorage if configured by user
 * 3. Current host with /ws path (upgrading http->ws and https->wss)
 */
function resolveDefaultWsUrl() {
  try {
    if (typeof window !== 'undefined' && window.VITE_WS_URL) {
      return window.VITE_WS_URL;
    }
    if (typeof process !== 'undefined' && process.env && process.env.VITE_WS_URL) {
      return process.env.VITE_WS_URL;
    }
  } catch {
    // Ignore environment access errors
  }

  try {
    const saved = sessionStorage.getItem('viberoom_ws_url');
    if (saved) return saved;
  } catch {
    // Ignore storage errors in sandboxed contexts
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

/**
 * Derive HTTP base URL corresponding to the configured WebSocket URL
 * so /api/report and /api/ice-config hit the same backend host.
 */
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
  const [showGuidelines, setShowGuidelines] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [toastMessage, setToastMessage] = useState(null);

  // --- Signaling Server Connection State ---
  const [wsUrl, setWsUrl] = useState(resolveDefaultWsUrl);
  const [wsUrlInput, setWsUrlInput] = useState(resolveDefaultWsUrl);
  // 'connecting' | 'connected' | 'disconnected' | 'error'
  const [serverStatus, setServerStatus] = useState('disconnected');
  const [serverError, setServerError] = useState(null);
  const [serverUserId, setServerUserId] = useState(null);
  const [serverReportToken, setServerReportToken] = useState(null);
  const [rtcConfig, setRtcConfig] = useState(DEFAULT_RTC_CONFIG);

  // --- Matchmaking & Authoritative Session State ---
  // 'idle' | 'searching' | 'connecting' | 'connected' | 'partner_disconnected' | 'error'
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [sessionId, setSessionId] = useState(null);
  const [partnerId, setPartnerId] = useState(null);
  const [partnerInterests, setPartnerInterests] = useState([]);
  const [matchedCommonTag, setMatchedCommonTag] = useState(null);
  const [blockedUsers, setBlockedUsers] = useState(() => {
    try {
      const saved = localStorage.getItem('viberoom_blocked_peers');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

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
  const [availableDevices, setAvailableDevices] = useState({ video: [], audio: [] });

  // --- Real-Time Chat State ---
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);

  // --- Mutable Refs for Authoritative Event Validation & WebRTC ---
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
  const blockedUsersRef = useRef(blockedUsers);
  const isMobileChatOpenRef = useRef(isMobileChatOpen);
  const chatBottomRef = useRef(null);
  const lastMessageTimestamp = useRef(0);
  const pendingReportCallbackRef = useRef(null);

  // Keep refs synchronized with state
  useEffect(() => {
    selectedInterestsRef.current = selectedInterests;
  }, [selectedInterests]);

  useEffect(() => {
    blockedUsersRef.current = blockedUsers;
  }, [blockedUsers]);

  useEffect(() => {
    isMobileChatOpenRef.current = isMobileChatOpen;
  }, [isMobileChatOpen]);

  useEffect(() => {
    rtcConfigRef.current = rtcConfig;
  }, [rtcConfig]);

  // Toast helper
  const showToast = useCallback((msg, duration = 3500) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(prev => (prev === msg ? null : prev));
    }, duration);
  }, []);

  // Fetch ICE configuration from backend /api/ice-config on mount or URL change
  useEffect(() => {
    let isMounted = true;
    const baseUrl = deriveHttpBaseUrl(wsUrl);
    fetch(`${baseUrl}/api/ice-config`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        if (isMounted && data && Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          setRtcConfig({
            iceServers: data.iceServers,
            iceCandidatePoolSize: 10
          });
        }
      })
      .catch(() => {
        // Fallback silently to default Google STUN servers if /api/ice-config is unavailable
      });

    return () => {
      isMounted = false;
    };
  }, [wsUrl]);

  // ==========================================
  // MEDIA STREAM ACQUISITION & CONTROLS
  // ==========================================
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

      if (navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setAvailableDevices({
          video: devices.filter(d => d.kind === 'videoinput'),
          audio: devices.filter(d => d.kind === 'audioinput')
        });
      }

      return stream;
    } catch (err) {
      console.error('Media acquisition error:', err);
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

  // ==========================================
  // WEBRTC PEER CONNECTION & ICE BUFFERING
  // ==========================================
  const cleanupPeerConnection = useCallback(() => {
    pendingCandidatesRef.current = [];
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
      } catch (err) {
        console.warn('Error closing RTCPeerConnection:', err);
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

  /**
   * Flush any ICE candidates that arrived before pc.remoteDescription was set
   */
  const flushPendingCandidates = useCallback(async (pc) => {
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
    const queued = pendingCandidatesRef.current.splice(0, pendingCandidatesRef.current.length);
    for (const candidateInit of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
      } catch (err) {
        console.warn('Failed to add buffered ICE candidate:', err);
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

    // Add local media tracks to peer connection
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // Receive remote tracks
    pc.ontrack = (event) => {
      if (activeSessionIdRef.current !== authoritativeSessionId) return;
      if (remoteVideoRef.current && event.streams && event.streams[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
        setConnectionStatus('connected');
      }
    };

    // Send local ICE candidates scoped to the authoritative sessionId
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

  // ==========================================
  // WEBSOCKET SIGNALING CLIENT LIFECYCLE
  // ==========================================
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
      ws = new WebSocket(targetUrl);
      wsRef.current = ws;
    } catch (err) {
      setServerStatus('error');
      setServerError(`Invalid WebSocket URL (${targetUrl}): ${err.message}`);
      return;
    }

    ws.onopen = () => {
      setServerStatus('connected');
      setServerError(null);
    };

    ws.onmessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case 'connected': {
          setServerUserId(msg.userId);
          setServerReportToken(msg.reportToken || null);
          if (msg.iceServers && Array.isArray(msg.iceServers) && msg.iceServers.length > 0) {
            setRtcConfig({
              iceServers: msg.iceServers,
              iceCandidatePoolSize: 10
            });
          }
          break;
        }

        case 'queued': {
          activeSessionIdRef.current = null;
          currentPartnerIdRef.current = null;
          setSessionId(null);
          setPartnerId(null);
          setConnectionStatus('searching');
          break;
        }

        case 'match_found': {
          const {
            sessionId: matchedSessionId,
            partnerId: matchedPartnerId,
            initiator,
            sharedInterests = [],
            partnerInterests: remoteInterests = []
          } = msg;

          if (!matchedSessionId || !matchedPartnerId) break;

          // Reset chat and set session state
          setMessages([]);
          setUnreadCount(0);
          setSessionId(matchedSessionId);
          setPartnerId(matchedPartnerId);
          setPartnerInterests(remoteInterests);
          setMatchedCommonTag(sharedInterests[0] || null);
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
            } catch (err) {
              console.error('Failed to create WebRTC offer:', err);
              showToast('WebRTC negotiation error. Skipping to next partner...');
            }
          }
          break;
        }

        case 'signal': {
          // Strictly validate authoritative sessionId to ignore stale events
          if (!msg.sessionId || msg.sessionId !== activeSessionIdRef.current) {
            return;
          }
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
              // Buffer candidate if remoteDescription has not yet been applied
              if (!pc.remoteDescription || !pc.remoteDescription.type) {
                pendingCandidatesRef.current.push(signalData.candidate);
              } else {
                await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
              }
            }
          } catch (err) {
            console.error('Error processing WebRTC signal:', err);
          }
          break;
        }

        case 'chat_message': {
          // Validate sessionId before rendering incoming chat message
          if (!msg.sessionId || msg.sessionId !== activeSessionIdRef.current) {
            return;
          }
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
          // Validate sessionId so delayed disconnect notices from previous sessions are ignored
          if (!msg.sessionId || msg.sessionId !== activeSessionIdRef.current) {
            return;
          }
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
        `Could not connect to WebSocket signaling server at ${targetUrl}. Ensure the Node.js server (node server.js) is running.`
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

  // Connect to WebSocket server on mount
  useEffect(() => {
    connectSignalingServer(wsUrl);
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      cleanupPeerConnection();
      stopLocalMedia();
    };
  }, []);

  // ==========================================
  // QUEUEING, SKIPPING & ROOM NAVIGATION
  // ==========================================
  const startMatchmaking = useCallback(() => {
    cleanupPeerConnection();
    setMessages([]);
    setUnreadCount(0);

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setConnectionStatus('error');
      setServerError('Signaling server is not connected. Click "Reconnect Signaling Server" to retry.');
      connectSignalingServer();
      return;
    }

    setConnectionStatus('searching');
    sendWsEvent({
      type: 'join_queue',
      interests: selectedInterestsRef.current,
      blockedIds: blockedUsersRef.current
    });
  }, [cleanupPeerConnection, connectSignalingServer, sendWsEvent]);

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
    if (previousSessionId) {
      sendWsEvent({
        type: 'next_partner',
        sessionId: previousSessionId,
        interests: selectedInterestsRef.current,
        blockedIds: blockedUsersRef.current
      });
    } else {
      sendWsEvent({
        type: 'join_queue',
        interests: selectedInterestsRef.current,
        blockedIds: blockedUsersRef.current
      });
    }
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

  // ==========================================
  // BLOCKING & BACKEND-VERIFIED REPORTING
  // ==========================================
  const persistBlockedPartner = useCallback((targetUserId) => {
    if (!targetUserId) return;
    setBlockedUsers(prev => {
      const updated = [...new Set([...prev, targetUserId])];
      try {
        localStorage.setItem('viberoom_blocked_peers', JSON.stringify(updated));
      } catch (err) {
        console.error('Failed to persist blocked peer:', err);
      }
      blockedUsersRef.current = updated;
      return updated;
    });
  }, []);

  const blockCurrentPartner = useCallback(() => {
    const targetPartner = currentPartnerIdRef.current;
    if (!targetPartner) return;
    persistBlockedPartner(targetPartner);
    showToast('Partner blocked locally. Finding someone new...');
    handleNextPartner();
  }, [persistBlockedPartner, showToast, handleNextPartner]);

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
      reporterUserId: serverUserId || 'anonymous',
      reason: selectedReportReason,
      details: reportDetails.trim().slice(0, 500)
    };

    try {
      const baseUrl = deriveHttpBaseUrl(wsUrl);
      const response = await fetch(`${baseUrl}/api/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(serverReportToken ? { 'X-VibeRoom-Report-Token': serverReportToken } : {})
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || `Server rejected report (HTTP ${response.status})`);
      }

      const result = await response.json();
      if (!result || !result.reportId) {
        throw new Error('Invalid server response: missing report confirmation ID.');
      }

      // Server confirmed receipt (HTTP 201)
      persistBlockedPartner(targetPartner);
      setIsSubmittingReport(false);
      setShowReportModal(false);
      setReportDetails('');
      showToast(`Report received by server (#${result.reportId}). Partner blocked.`);
      handleNextPartner();
    } catch (httpErr) {
      // Fallback: try sending over active WebSocket if connected and await server report_ack
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          const wsAck = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingReportCallbackRef.current = null;
              reject(new Error('Report confirmation timed out from server.'));
            }, 4000);

            pendingReportCallbackRef.current = (ackResult) => {
              clearTimeout(timeout);
              if (ackResult.ok) resolve(ackResult);
              else reject(new Error(ackResult.message || 'Server rejected report.'));
            };

            sendWsEvent({
              type: 'report',
              ...payload
            });
          });

          persistBlockedPartner(targetPartner);
          setIsSubmittingReport(false);
          setShowReportModal(false);
          setReportDetails('');
          showToast(`Report received by server (#${wsAck.reportId}). Partner blocked.`);
          handleNextPartner();
          return;
        } catch (wsErr) {
          setIsSubmittingReport(false);
          setReportError(`Could not record report on server: ${wsErr.message}`);
          return;
        }
      }

      setIsSubmittingReport(false);
      setReportError(`Report could not be sent: ${httpErr.message}. Backend server is unreachable.`);
    }
  };

  // ==========================================
  // REAL-TIME TEXT CHAT DISPATCH
  // ==========================================
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

  // Auto-scroll chat pane
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Attach localStream whenever view switches between Lobby and Room
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
    if (!ageConfirmed) {
      showToast('You must confirm you are 18+ to enter VibeRoom.');
      return;
    }
    const stream = await startLocalMedia();
    if (stream) {
      setInLobby(false);
      startMatchmaking();
    }
  };

  // ==========================================
  // RENDER: LOBBY & LANDING VIEW
  // ==========================================
  if (inLobby) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col justify-between selection:bg-fuchsia-500 selection:text-white font-sans">
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
                WebRTC Live
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
                  ? 'Connecting Server...'
                  : 'Signaling Offline'}
              </span>
              <Sliders className="w-3 h-3 opacity-75" />
            </button>

            <button 
              onClick={() => setShowGuidelines(true)}
              className="flex items-center space-x-2 text-sm text-neutral-400 hover:text-white transition px-3 py-1.5 rounded-lg border border-neutral-800 hover:border-neutral-700 bg-neutral-900/60"
            >
              <ShieldAlert className="w-4 h-4 text-cyan-400" />
              <span>Safety & Rules</span>
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
                {serverUserId && (
                  <span className="text-[11px] text-neutral-500 font-mono">
                    (ID: {serverUserId})
                  </span>
                )}
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

        {/* Signaling Offline Warning Banner */}
        {serverStatus !== 'connected' && (
          <div className="bg-red-950/60 border-b border-red-900/60 px-6 py-2.5">
            <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-red-200">
              <div className="flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <span>
                  {serverError || `Signaling server (${wsUrl}) is currently unreachable. Start the backend with "npm start" or configure the server URL.`}
                </span>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => connectSignalingServer()}
                  className="px-3 py-1 rounded-lg bg-red-800/80 hover:bg-red-700 text-white font-semibold transition flex items-center space-x-1"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Reconnect Signaling Server</span>
                </button>
                <button
                  onClick={() => setShowServerConfig(true)}
                  className="px-2.5 py-1 rounded-lg bg-neutral-900/80 hover:bg-neutral-800 text-neutral-300 border border-neutral-700 transition"
                >
                  Configure URL
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Hero Section */}
        <main className="flex-1 max-w-5xl mx-auto w-full px-6 py-12 flex flex-col lg:flex-row items-center gap-12 justify-center">
          {/* Left Column: Config & Action */}
          <div className="flex-1 space-y-6 text-left">
            <div className="inline-flex items-center space-x-2 text-xs font-semibold px-3 py-1 rounded-full bg-cyan-950/60 border border-cyan-800/60 text-cyan-300">
              <span className={`w-2 h-2 rounded-full ${serverStatus === 'connected' ? 'bg-cyan-400 animate-ping' : 'bg-amber-400'}`}></span>
              <span>Real-Time WebSocket Matchmaking & P2P Video</span>
            </div>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-tight">
              Meet new vibes. <br />
              <span className="bg-gradient-to-r from-fuchsia-400 via-pink-400 to-cyan-400 bg-clip-text text-transparent">
                Completely spontaneous.
              </span>
            </h1>

            <p className="text-neutral-400 text-base sm:text-lg max-w-lg leading-relaxed">
              Connect face-to-face with real people across different networks and devices based on shared interests. No accounts required.
            </p>

            {/* Interest Tags Selector */}
            <div className="space-y-3 pt-2">
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

            {/* 18+ Age Disclaimer & Agreement */}
            <div className="pt-3 border-t border-neutral-800/80 space-y-4">
              <label className="flex items-start space-x-3 cursor-pointer group">
                <input 
                  type="checkbox"
                  checked={ageConfirmed}
                  onChange={(e) => setAgeConfirmed(e.target.checked)}
                  className="mt-1 w-4 h-4 rounded bg-neutral-900 border-neutral-700 text-fuchsia-500 focus:ring-fuchsia-500 focus:ring-offset-neutral-950 cursor-pointer accent-fuchsia-500"
                />
                <span className="text-xs text-neutral-400 group-hover:text-neutral-300 transition select-none">
                  I certify that I am at least <strong>18 years old</strong> and agree to adhere to the 
                  <button type="button" onClick={(e) => { e.stopPropagation(); setShowGuidelines(true); }} className="text-cyan-400 underline ml-1 hover:text-cyan-300">
                    Community Code of Conduct
                  </button>. Note: Self-declaration alone does not verify a user's age.
                </span>
              </label>

              {/* Start Chat Button */}
              <button
                onClick={handleStartVibing}
                disabled={!ageConfirmed}
                className={`w-full py-4 px-6 rounded-2xl font-bold text-lg flex items-center justify-center space-x-3 shadow-xl transition-all duration-300 transform active:scale-95 ${
                  ageConfirmed 
                    ? 'bg-gradient-to-r from-fuchsia-600 to-cyan-600 hover:from-fuchsia-500 hover:to-cyan-500 text-white shadow-fuchsia-500/25 hover:shadow-cyan-500/25 cursor-pointer'
                    : 'bg-neutral-800/80 text-neutral-500 cursor-not-allowed border border-neutral-700/40'
                }`}
              >
                <span>Enter Room & Start Chat</span>
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
                    Camera preview inactive.<br/>Will initialize upon entering room.
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

              {/* Hardware Preview Badge */}
              <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-md px-3 py-1 rounded-full border border-white/10 text-[11px] font-semibold text-neutral-300 flex items-center space-x-1.5">
                <span className={`w-2 h-2 rounded-full ${localStream ? 'bg-emerald-400' : 'bg-neutral-500'}`}></span>
                <span>{localStream ? 'Webcam Active' : 'Webcam Standby'}</span>
              </div>
            </div>

            <div className="mt-4 flex items-center space-x-4 text-xs text-neutral-500">
              <span>🔒 Authoritative Session IDs</span>
              <span>•</span>
              <span>🚫 Zero Default Recording</span>
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-neutral-900 px-6 py-4 text-center text-xs text-neutral-500">
          VibeRoom © {new Date().getFullYear()} — Real-time WebRTC video chat. For adults 18+ only.
        </footer>

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
                <li><strong>Zero Tolerance for Nudity or Sexual Acts:</strong> Unsolicited exposure or explicit content is strictly prohibited.</li>
                <li><strong>No Harassment or Hate:</strong> Treat every person with respect. Harassment, threats, or hate speech are forbidden.</li>
                <li><strong>Privacy & Media:</strong> Video and audio streams flow peer-to-peer via WebRTC and are not recorded by VibeRoom. Never share personal or financial data.</li>
                <li><strong>Moderation & Reports:</strong> Submitting a report records the session ID, reported user ID, and reason on the server log for review and blocks that user on your device.</li>
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

  // ==========================================
  // RENDER: ACTIVE VIDEO ROOM CHAT VIEW
  // ==========================================
  return (
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

          {/* Connection Pill */}
          <div className="flex items-center space-x-2 bg-neutral-800/80 px-3 py-1 rounded-full border border-neutral-700/60 text-xs">
            <span className={`w-2 h-2 rounded-full ${
              connectionStatus === 'connected' ? 'bg-emerald-400 shadow-sm shadow-emerald-400 animate-pulse' :
              connectionStatus === 'connecting' ? 'bg-amber-400 animate-ping' :
              connectionStatus === 'searching' ? 'bg-cyan-400 animate-bounce' : 'bg-red-400'
            }`} />
            <span className="capitalize font-medium text-neutral-300">
              {connectionStatus === 'connected' ? 'Connected' :
               connectionStatus === 'connecting' ? 'Handshaking...' :
               connectionStatus === 'searching' ? 'Waiting in Queue...' : 
               connectionStatus === 'partner_disconnected' ? 'Partner Left' :
               connectionStatus === 'error' ? 'Signaling Error' : 'Standby'}
            </span>
          </div>

          {matchedCommonTag && connectionStatus === 'connected' && (
            <span className="hidden md:inline-flex items-center space-x-1 text-xs bg-fuchsia-950/70 border border-fuchsia-800/60 text-fuchsia-300 px-2.5 py-0.5 rounded-full font-medium">
              <Tag className="w-3 h-3 text-fuchsia-400" />
              <span>Matched on: {matchedCommonTag}</span>
            </span>
          )}
        </div>

        {/* Room Header Actions */}
        <div className="flex items-center space-x-2">
          {(connectionStatus === 'connected' || connectionStatus === 'connecting') && partnerId && (
            <>
              <button 
                onClick={() => {
                  setReportError(null);
                  setShowReportModal(true);
                }}
                className="flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-neutral-800/90 text-neutral-300 hover:text-red-400 hover:bg-neutral-800 border border-neutral-700/60 transition"
                title="Report User"
              >
                <Flag className="w-3.5 h-3.5 text-red-400" />
                <span className="hidden sm:inline">Report</span>
              </button>
              <button 
                onClick={blockCurrentPartner}
                className="flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-neutral-800/90 text-neutral-300 hover:text-amber-400 hover:bg-neutral-800 border border-neutral-700/60 transition"
                title="Block Partner"
              >
                <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                <span className="hidden sm:inline">Block</span>
              </button>
            </>
          )}

          {/* Mobile Chat Toggle Button */}
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

      {/* Main Workspace (Video Grid & Chat) */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Left Side: Video Canvas Grid */}
        <div className="flex-1 bg-black flex flex-col justify-between p-3 sm:p-4 relative overflow-hidden">
          {/* Partner (Remote) Video Container */}
          <div className="relative w-full h-full rounded-2xl sm:rounded-3xl bg-neutral-900 border border-neutral-800 overflow-hidden flex items-center justify-center shadow-inner">
            <video 
              ref={remoteVideoRef} 
              autoPlay 
              playsInline 
              className={`w-full h-full object-cover ${connectionStatus === 'connected' ? 'block' : 'hidden'}`}
            />

            {/* Inactive & Searching State Overlays */}
            {connectionStatus !== 'connected' && (
              <div className="flex flex-col items-center justify-center text-center p-6 space-y-4 max-w-md">
                {connectionStatus === 'searching' && (
                  <>
                    <div className="relative">
                      <div className="w-20 h-20 rounded-full border-4 border-fuchsia-500/20 border-t-fuchsia-500 animate-spin flex items-center justify-center">
                        <Sparkles className="w-8 h-8 text-fuchsia-400" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <h3 className="text-lg font-bold text-white">Searching server queue for a partner...</h3>
                      <p className="text-xs text-neutral-400">
                        Prioritizing interests: {selectedInterests.slice(0, 3).join(', ')} (with random fallback)
                      </p>
                    </div>
                  </>
                )}

                {connectionStatus === 'connecting' && (
                  <div className="space-y-3">
                    <RefreshCw className="w-12 h-12 text-cyan-400 animate-spin mx-auto" />
                    <h3 className="text-lg font-bold text-white">Partner Matched!</h3>
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
                      onClick={startMatchmaking}
                      className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 font-bold text-xs text-white shadow-lg shadow-fuchsia-500/20"
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
                    <div className="space-y-1">
                      <h3 className="text-base font-bold text-white">Signaling Server Unreachable</h3>
                      <p className="text-xs text-neutral-400">
                        {serverError || `Lost connection to ${wsUrl}.`}
                      </p>
                    </div>
                    <div className="flex items-center justify-center space-x-3">
                      <button 
                        onClick={() => {
                          connectSignalingServer();
                          setTimeout(() => startMatchmaking(), 400);
                        }}
                        className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-fuchsia-600 to-cyan-600 font-bold text-xs text-white shadow-lg flex items-center space-x-2"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Reconnect Signaling Server</span>
                      </button>
                      <button
                        onClick={handleLeaveToLobby}
                        className="px-4 py-2.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-xs text-neutral-200 font-semibold"
                      >
                        Back to Lobby
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Local Webcam Picture-in-Picture */}
            <div className="absolute top-4 right-4 w-32 sm:w-48 aspect-[4/3] rounded-xl sm:rounded-2xl bg-neutral-900 border-2 border-neutral-700/80 overflow-hidden shadow-2xl z-10 transition-all hover:scale-105">
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
              <div className="absolute bottom-1.5 left-2 text-[10px] font-bold text-white/90 bg-black/60 px-2 py-0.5 rounded-md backdrop-blur-sm">
                You {isAudioMuted && '(Muted)'}
              </div>
            </div>
          </div>

          {/* Bottom Floating Control Hub */}
          <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 flex items-center space-x-3 bg-neutral-900/90 backdrop-blur-xl border border-neutral-800 px-5 py-3 rounded-full shadow-2xl z-20">
            {/* Audio Toggle */}
            <button
              onClick={toggleAudio}
              className={`p-3 rounded-full transition ${
                isAudioMuted 
                  ? 'bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30' 
                  : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700 border border-neutral-700'
              }`}
              title={isAudioMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            >
              {isAudioMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
            </button>

            {/* Video Toggle */}
            <button
              onClick={toggleVideo}
              className={`p-3 rounded-full transition ${
                isVideoMuted 
                  ? 'bg-red-500/20 text-red-400 border border-red-500/40 hover:bg-red-500/30' 
                  : 'bg-neutral-800 text-neutral-200 hover:bg-neutral-700 border border-neutral-700'
              }`}
              title={isVideoMuted ? 'Turn Camera On' : 'Turn Camera Off'}
            >
              {isVideoMuted ? <CameraOff className="w-5 h-5" /> : <Camera className="w-5 h-5" />}
            </button>

            {/* SKIP / NEXT PARTNER BUTTON */}
            <button
              onClick={handleNextPartner}
              className="flex items-center space-x-2 px-6 py-3 rounded-full bg-gradient-to-r from-fuchsia-600 to-cyan-500 hover:from-fuchsia-500 hover:to-cyan-400 text-white font-extrabold text-sm shadow-lg shadow-fuchsia-500/25 active:scale-95 transition-all"
            >
              <span>Next Partner</span>
              <SkipForward className="w-4 h-4 fill-current" />
            </button>
          </div>
        </div>

        {/* Right Side: Real-time Text Chat Pane (Desktop + Mobile Drawer) */}
        <aside className={`
          fixed md:relative inset-y-0 right-0 z-30 w-full sm:w-80 md:w-88 lg:w-96 
          bg-neutral-900/95 md:bg-neutral-900 border-l border-neutral-800 flex flex-col 
          transition-transform duration-300 ease-in-out
          ${isMobileChatOpen ? 'translate-x-0' : 'translate-x-full md:translate-x-0'}
        `}>
          {/* Chat Header */}
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

          {/* Chat Stream Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin scrollbar-thumb-neutral-700">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-neutral-500 space-y-2 p-4">
                <Sparkles className="w-6 h-6 text-neutral-600" />
                <p className="text-xs">
                  {connectionStatus === 'connected'
                    ? 'Connected! Say hi or drop a conversation starter.'
                    : 'Messages are scoped to your active match and cleared when switching partners.'}
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <div 
                  key={m.id} 
                  className={`flex flex-col ${m.sender === 'you' ? 'items-end' : 'items-start'}`}
                >
                  <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed break-words shadow-sm ${
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

          {/* Chat Input Form */}
          <form onSubmit={handleSendMessage} className="p-3 border-t border-neutral-800 bg-neutral-950/60 flex items-center space-x-2">
            <input 
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={connectionStatus === 'connected' ? 'Type a friendly message...' : 'Connect with someone to chat...'}
              disabled={connectionStatus !== 'connected'}
              maxLength={400}
              className="flex-1 bg-neutral-900 border border-neutral-700/80 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-fuchsia-500 transition disabled:opacity-50"
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

            <p className="text-xs text-neutral-400 leading-relaxed">
              Submitting sends the active session ID (<code className="text-neutral-300">{sessionId || 'N/A'}</code>) and partner ID (<code className="text-neutral-300">{partnerId || 'N/A'}</code>) to the backend moderation log.
            </p>

            <div className="space-y-2">
              <label className="text-[11px] uppercase tracking-wider text-neutral-400 font-semibold">
                Violation Reason
              </label>
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
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] uppercase tracking-wider text-neutral-400 font-semibold">
                Additional Context (Optional)
              </label>
              <textarea
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Describe what happened..."
                className="w-full bg-neutral-950 border border-neutral-700 rounded-xl p-2.5 text-xs text-white placeholder-neutral-500 focus:outline-none focus:border-red-500"
              />
            </div>

            {reportError && (
              <div className="p-3 rounded-xl bg-red-950/70 border border-red-800 text-xs text-red-200 flex items-start space-x-2">
                <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                <span>{reportError}</span>
              </div>
            )}

            <div className="flex items-center justify-end space-x-2 pt-2">
              {reportError && (
                <button
                  type="button"
                  onClick={() => {
                    blockCurrentPartner();
                    setShowReportModal(false);
                  }}
                  className="px-3 py-2 rounded-xl bg-amber-900/50 hover:bg-amber-800/60 border border-amber-700/60 text-amber-200 text-xs font-semibold transition"
                >
                  Block & Skip Locally Only
                </button>
              )}
              <button
                type="submit"
                disabled={isSubmittingReport}
                className="px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:bg-neutral-800 text-white text-xs font-bold transition flex items-center space-x-1.5"
              >
                {isSubmittingReport ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Sending to Server...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Submit Report & Block</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Floating System Toast */}
      {toastMessage && (
        <div className="fixed top-16 left-1/2 transform -translate-x-1/2 z-50 bg-neutral-900/95 border border-fuchsia-500/50 text-white text-xs px-4 py-2.5 rounded-full shadow-2xl backdrop-blur-md flex items-center space-x-2">
          <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
          <span>{toastMessage}</span>
        </div>
      )}
    </div>
  );
}