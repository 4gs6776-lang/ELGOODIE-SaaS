import { useRef, useState, useCallback, useEffect } from 'react'
import { supabase } from './supabaseClient'

// =====================================================================
// useWebRTC — manages a WebRTC peer-to-peer video/audio connection
// using Supabase Realtime as the signaling channel.
//
// Architecture:
//   Doctor (browser) ←→ Supabase Realtime (signaling) ←→ Patient (browser)
//                          ↓
//                    WebRTC peer-to-peer video/audio
//
// No separate signaling server needed — Supabase Realtime's broadcast
// channels carry the SDP offer/answer + ICE candidates.
//
// STUN servers: Google's free STUN (stun:stun.l.google.com:19302)
// TURN: Optional — only needed if both peers are behind strict NAT.
//       Can be configured later via Twilio/Xirsys.
//
// Usage:
//   const webrtc = useWebRTC({ roomId, isInitiator, onRemoteStream })
//   webrtc.startCall()    → getUserMedia + create peer connection
//   webrtc.endCall()      → close connection + stop tracks
//   webrtc.toggleVideo()  → mute/unmute camera
//   webrtc.toggleAudio()  → mute/unmute mic
// =====================================================================

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
]

export function useWebRTC({ roomId, isInitiator = false, onRemoteStream }) {
  const peerConnectionRef = useRef(null)
  const localStreamRef = useRef(null)
  const remoteStreamRef = useRef(null)
  const channelRef = useRef(null)
  const iceCandidatesBufferRef = useRef([])

  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [callStatus, setCallStatus] = useState('idle') // idle | connecting | connected | ended | failed
  const [videoEnabled, setVideoEnabled] = useState(true)
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [error, setError] = useState('')
  const [connectionQuality, setConnectionQuality] = useState(null)

  // -----------------------------------------------------------------
  // Supabase Realtime signaling channel
  // -----------------------------------------------------------------
  const getChannel = useCallback(() => {
    if (channelRef.current) return channelRef.current
    const channel = supabase.channel(`webrtc-${roomId}`, {
      config: { broadcast: { self: false }, presence: { key: roomId } }
    })
    channelRef.current = channel
    return channel
  }, [roomId])

  // -----------------------------------------------------------------
  // Create the RTCPeerConnection + wire up event handlers
  // -----------------------------------------------------------------
  const createPeerConnection = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current)
      })
    }

    // Handle remote stream
    pc.ontrack = (event) => {
      const [stream] = event.streams
      remoteStreamRef.current = stream
      setRemoteStream(stream)
      if (onRemoteStream) onRemoteStream(stream)
    }

    // Handle ICE candidates — send them via the signaling channel
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const channel = getChannel()
        channel.send({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
          from: isInitiator ? 'initiator' : 'responder',
        })
      }
    }

    // Connection state
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') setCallStatus('connected')
      else if (state === 'disconnected' || state === 'failed') {
        setCallStatus(state === 'failed' ? 'failed' : 'ended')
      }
    }

    // ICE connection state for quality monitoring
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState
      if (state === 'checking') setConnectionQuality({ state: 'connecting' })
      else if (state === 'connected' || state === 'completed') setConnectionQuality({ state: 'good' })
      else if (state === 'failed') setConnectionQuality({ state: 'failed' })
      else if (state === 'disconnected') setConnectionQuality({ state: 'reconnecting' })
    }

    peerConnectionRef.current = pc
    return pc
  }, [isInitiator, getChannel, onRemoteStream])

  // -----------------------------------------------------------------
  // Start the call — getUserMedia + create peer connection
  // -----------------------------------------------------------------
  const startCall = useCallback(async () => {
    setError('')
    setCallStatus('connecting')

    try {
      // Request camera + microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      })
      localStreamRef.current = stream
      setLocalStream(stream)

      // Create peer connection
      const pc = createPeerConnection()

      // Set up the signaling channel
      const channel = getChannel()

      channel.on('broadcast', { event: '*' }, (payload) => {
        const data = payload.payload
        if (!data) return

        // Ignore our own messages
        if (data.from === (isInitiator ? 'initiator' : 'responder')) return

        if (data.type === 'offer') {
          // Responder receives the offer
          pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
            .then(() => pc.createAnswer())
            .then(answer => pc.setLocalDescription(answer))
            .then(() => {
              channel.send({
                type: 'answer',
                sdp: pc.localDescription.sdp,
                from: 'responder',
              })
            })
            .catch(err => setError('Signaling error: ' + err.message))
        }
        else if (data.type === 'answer') {
          // Initiator receives the answer
          pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
            .catch(err => setError('Answer error: ' + err.message))
        }
        else if (data.type === 'ice-candidate') {
          // Add ICE candidate
          if (pc.remoteDescription) {
            pc.addIceCandidate(data.candidate).catch(() => {})
          } else {
            iceCandidatesBufferRef.current.push(data.candidate)
          }
        }
      })

      channel.subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return

        // If initiator, create + send the offer
        if (isInitiator) {
          try {
            const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true })
            await pc.setLocalDescription(offer)
            channel.send({
              type: 'offer',
              sdp: offer.sdp,
              from: 'initiator',
            })
          } catch (err) {
            setError('Could not create offer: ' + err.message)
            setCallStatus('failed')
          }
        }
      })
    } catch (err) {
      setError(err.message || 'Could not access camera/microphone. Please check permissions.')
      setCallStatus('failed')
    }
  }, [createPeerConnection, getChannel, isInitiator])

  // -----------------------------------------------------------------
  // End the call — close connection + stop tracks
  // -----------------------------------------------------------------
  const endCall = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close()
      peerConnectionRef.current = null
    }
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }
    setLocalStream(null)
    setRemoteStream(null)
    setCallStatus('ended')
  }, [])

  // -----------------------------------------------------------------
  // Toggle video / audio
  // -----------------------------------------------------------------
  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return
    const videoTrack = localStreamRef.current.getVideoTracks()[0]
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled
      setVideoEnabled(videoTrack.enabled)
    }
  }, [])

  const toggleAudio = useCallback(() => {
    if (!localStreamRef.current) return
    const audioTrack = localStreamRef.current.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
      setAudioEnabled(audioTrack.enabled)
    }
  }, [])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(t => t.stop())
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close()
      }
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
      }
    }
  }, [])

  return {
    localStream,
    remoteStream,
    callStatus,
    videoEnabled,
    audioEnabled,
    connectionQuality,
    error,
    startCall,
    endCall,
    toggleVideo,
    toggleAudio,
  }
}
