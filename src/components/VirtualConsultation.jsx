import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabaseClient'
import { useOfflineTable } from '../lib/useOfflineTable'
import { useWebRTC } from '../lib/useWebRTC'
import { writeAudit } from '../lib/audit'
import { Video, VideoOff, Mic, MicOff, PhoneOff, Send, X, MessageSquare, Maximize2, Circle, Square } from 'lucide-react'

// =====================================================================
// VirtualConsultation — video + text chat consultation component
// =====================================================================
// Mounted as a full-screen overlay when the doctor starts a virtual
// consultation. Handles:
//   - WebRTC video/audio via useWebRTC hook
//   - Text chat messages (saved to virtual_consultation_messages)
//   - Call status management (scheduled → waiting → in_progress → completed)
//   - Session summary at the end
//
// The patient joins from the patient portal (separate app) using the
// same room_id — the signaling happens via Supabase Realtime.
// =====================================================================

export default function VirtualConsultation({ patient, hospital, consultationId, roomId, onClose }) {
  const { profile } = useAuth()
  const { addRecord: addMessage, records: messages } = useOfflineTable('virtual_consultation_messages', hospital?.id, { realtime: true })
  const { updateRecord: updateConsultation } = useOfflineTable('virtual_consultations', hospital?.id)

  const webrtc = useWebRTC({
    roomId,
    isInitiator: true, // The doctor initiates the call
    onRemoteStream: () => {
      // Patient joined — update the consultation status
      if (consultationId) {
        updateConsultation(consultationId, {
          status: 'in_progress',
          actual_start: new Date().toISOString(),
        })
      }
    },
  })

  const [chatInput, setChatInput] = useState('')
  const [showChat, setShowChat] = useState(true)
  const [callDuration, setCallDuration] = useState(0)
  const [summary, setSummary] = useState('')
  const [showSummary, setShowSummary] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const mediaRecorderRef = useRef(null)
  const recordedChunksRef = useRef([])
  const messagesEndRef = useRef(null)
  const callTimerRef = useRef(null)

  // Scroll chat to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Call timer
  useEffect(() => {
    if (webrtc.callStatus === 'connected') {
      callTimerRef.current = setInterval(() => setCallDuration(d => d + 1), 1000)
    } else {
      clearInterval(callTimerRef.current)
    }
    return () => clearInterval(callTimerRef.current)
  }, [webrtc.callStatus])

  // Auto-start the call when the component mounts
  useEffect(() => {
    webrtc.startCall()
    writeAudit({
      hospitalId: hospital.id, actor: profile,
      action: 'telemedicine.call_started',
      entityType: 'virtual_consultations', entityId: consultationId,
      patientId: patient?.id,
      summary: `Started virtual consultation with ${patient?.full_name || 'patient'}`,
      metadata: { room_id: roomId, consultation_id: consultationId },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Handle end call
  const handleEndCall = useCallback(async () => {
    // Stop recording if active
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop()
    }

    webrtc.endCall()

    if (consultationId) {
      await updateConsultation(consultationId, {
        status: 'completed',
        actual_end: new Date().toISOString(),
        duration_seconds: callDuration,
        is_recorded: isRecording,
      })

      // Upload recording if any chunks were captured
      if (recordedChunksRef.current.length > 0) {
        try {
          const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' })
          const recordingPath = `${hospital.id}/virtual-consultations/${consultationId}.webm`
          await supabase.storage.from('hospital-logos').upload(recordingPath, blob, { upsert: true, contentType: 'video/webm' })
          await updateConsultation(consultationId, { recording_path: recordingPath })
        } catch (err) {
          console.warn('Could not upload recording:', err.message)
        }
      }

      writeAudit({
        hospitalId: hospital.id, actor: profile,
        action: 'telemedicine.call_ended',
        entityType: 'virtual_consultations', entityId: consultationId,
        patientId: patient?.id,
        summary: `Ended virtual consultation with ${patient?.full_name || 'patient'} (${Math.floor(callDuration / 60)}m ${callDuration % 60}s)`,
        metadata: { room_id: roomId, duration_seconds: callDuration },
      })
    }

    setShowSummary(true)
  }, [webrtc, consultationId, updateConsultation, hospital, profile, patient, roomId, callDuration])

  // Send chat message
  const handleSendMessage = useCallback(async (e) => {
    e?.preventDefault()
    if (!chatInput.trim()) return

    await addMessage({
      virtual_consultation_id: consultationId,
      sender_id: profile.id,
      sender_type: 'doctor',
      message_type: 'text',
      content: chatInput.trim(),
    })

    setChatInput('')
  }, [chatInput, addMessage, consultationId, profile])

  // Save session summary
  const handleSaveSummary = useCallback(async () => {
    if (consultationId) {
      await updateConsultation(consultationId, {
        session_summary: summary.trim() || null,
      })
    }
    onClose()
  }, [consultationId, updateConsultation, summary, onClose])

  // Toggle recording — uses MediaRecorder API to capture the local + remote
  // audio/video. The recording is uploaded to Supabase Storage when the
  // call ends (in handleEndCall).
  const toggleRecording = useCallback(() => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop()
      }
      setIsRecording(false)
    } else {
      // Start recording — combine local + remote streams
      try {
        const combinedStream = new MediaStream()
        // Add remote tracks (patient video/audio)
        if (webrtc.remoteStream) {
          webrtc.remoteStream.getTracks().forEach(t => combinedStream.addTrack(t))
        }
        // Add local tracks (doctor audio — skip local video to save space)
        if (webrtc.localStream) {
          webrtc.localStream.getAudioTracks().forEach(t => combinedStream.addTrack(t))
        }

        const recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm;codecs=vp8,opus' })
        recordedChunksRef.current = []

        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) recordedChunksRef.current.push(e.data)
        }

        recorder.start(1000) // collect data every 1 second
        mediaRecorderRef.current = recorder
        setIsRecording(true)

        writeAudit({
          hospitalId: hospital.id, actor: profile,
          action: 'telemedicine.recording_started',
          entityType: 'virtual_consultations', entityId: consultationId,
          patientId: patient?.id,
          summary: `Started recording virtual consultation with ${patient?.full_name || 'patient'}`,
        })
      } catch (err) {
        console.error('Could not start recording:', err.message)
      }
    }
  }, [isRecording, webrtc.remoteStream, webrtc.localStream, hospital, profile, consultationId, patient])

  const formatDuration = (seconds) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  const callStatusColor = {
    idle: 'var(--muted)',
    connecting: 'var(--gold)',
    connected: 'var(--success)',
    ended: 'var(--muted)',
    failed: 'var(--danger)',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: '#000', display: 'flex', flexDirection: 'column',
    }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '12px 20px', background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(10px)', color: '#fff',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Video size={18} style={{ color: 'var(--teal)' }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{patient?.full_name || 'Virtual Consultation'}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: callStatusColor[webrtc.callStatus] }} />
              {webrtc.callStatus === 'connecting' && 'Connecting…'}
              {webrtc.callStatus === 'connected' && `Connected · ${formatDuration(callDuration)}`}
              {webrtc.callStatus === 'ended' && 'Call ended'}
              {webrtc.callStatus === 'failed' && 'Connection failed'}
              {webrtc.callStatus === 'idle' && 'Starting…'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowChat(s => !s)} style={{
            width: 36, height: 36, borderRadius: 8, border: 'none',
            background: showChat ? 'rgba(0,199,199,0.2)' : 'rgba(255,255,255,0.1)',
            color: showChat ? 'var(--teal)' : '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} title="Toggle chat">
            <MessageSquare size={16} />
          </button>
          <button onClick={onClose} style={{
            width: 36, height: 36, borderRadius: 8, border: 'none',
            background: 'rgba(255,255,255,0.1)', color: '#fff', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} title="Close (does not end call)">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Error */}
      {webrtc.error && (
        <div style={{
          position: 'absolute', top: 60, left: '50%', transform: 'translateX(-50%)',
          padding: '10px 16px', borderRadius: 8, background: 'rgba(240,79,95,0.9)',
          color: '#fff', fontSize: 12.5, zIndex: 10, maxWidth: 400,
        }}>
          {webrtc.error}
        </div>
      )}

      {/* Video area */}
      <div style={{ flex: 1, display: 'flex', position: 'relative', overflow: 'hidden' }}>
        {/* Remote video (patient) — fills the screen */}
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {webrtc.remoteStream ? (
            <video
              autoPlay
              playsInline
              ref={el => { if (el && webrtc.remoteStream) { if (el.srcObject !== webrtc.remoteStream) el.srcObject = webrtc.remoteStream } }}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.5)' }}>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
                {webrtc.callStatus === 'connecting' ? 'Waiting for patient to join…' : 'No video stream'}
              </div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.3)' }}>
                The patient will appear here when they connect
              </div>
            </div>
          )}
        </div>

        {/* Local video (doctor) — picture-in-picture */}
        <div style={{
          position: 'absolute', bottom: 80, right: showChat ? 340 : 20,
          width: 180, height: 135, borderRadius: 12, overflow: 'hidden',
          border: '2px solid rgba(255,255,255,0.2)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
          zIndex: 5,
        }}>
          {webrtc.localStream ? (
            <video
              autoPlay
              playsInline
              muted
              ref={el => { if (el && webrtc.localStream) { if (el.srcObject !== webrtc.localStream) el.srcObject = webrtc.localStream } }}
              style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
            />
          ) : (
            <div style={{ width: '100%', height: '100%', background: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 11 }}>
              Camera off
            </div>
          )}
        </div>

        {/* Chat panel */}
        {showChat && (
          <div style={{
            width: 320, background: 'rgba(10,10,15,0.85)', backdropFilter: 'blur(10px)',
            display: 'flex', flexDirection: 'column', borderLeft: '1px solid rgba(255,255,255,0.1)',
          }}>
            {/* Chat messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>
              {(messages || []).filter(m => m.virtual_consultation_id === consultationId).map(m => (
                <div key={m.id} style={{
                  marginBottom: 10,
                  display: 'flex',
                  justifyContent: m.sender_type === 'doctor' ? 'flex-end' : 'flex-start',
                }}>
                  <div style={{
                    maxWidth: '80%', padding: '8px 12px', borderRadius: 12,
                    background: m.sender_type === 'doctor' ? 'var(--teal)' : 'rgba(255,255,255,0.1)',
                    color: m.sender_type === 'doctor' ? '#000' : '#fff',
                    fontSize: 12.5, lineHeight: 1.4,
                  }}>
                    {m.content}
                    <div style={{ fontSize: 9, opacity: 0.6, marginTop: 2, textAlign: m.sender_type === 'doctor' ? 'left' : 'right' }}>
                      {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Chat input */}
            <form onSubmit={handleSendMessage} style={{ display: 'flex', gap: 6, padding: '10px 12px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                placeholder="Type a message…"
                style={{
                  flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)',
                  background: 'rgba(255,255,255,0.05)', color: '#fff', fontSize: 12.5, outline: 'none',
                }}
              />
              <button type="submit" style={{
                width: 34, height: 34, borderRadius: 8, border: 'none',
                background: 'var(--teal)', color: '#000', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Send size={14} />
              </button>
            </form>
          </div>
        )}
      </div>

      {/* Bottom control bar */}
      {!showSummary && (
        <div style={{
          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12,
          padding: '16px 20px', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)',
        }}>
          <button onClick={webrtc.toggleVideo} style={{
            width: 44, height: 44, borderRadius: '50%', border: 'none',
            background: webrtc.videoEnabled ? 'rgba(255,255,255,0.15)' : 'rgba(240,79,95,0.3)',
            color: webrtc.videoEnabled ? '#fff' : 'var(--danger)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} title={webrtc.videoEnabled ? 'Turn off camera' : 'Turn on camera'}>
            {webrtc.videoEnabled ? <Video size={18} /> : <VideoOff size={18} />}
          </button>
          <button onClick={webrtc.toggleAudio} style={{
            width: 44, height: 44, borderRadius: '50%', border: 'none',
            background: webrtc.audioEnabled ? 'rgba(255,255,255,0.15)' : 'rgba(240,79,95,0.3)',
            color: webrtc.audioEnabled ? '#fff' : 'var(--danger)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} title={webrtc.audioEnabled ? 'Mute microphone' : 'Unmute microphone'}>
            {webrtc.audioEnabled ? <Mic size={18} /> : <MicOff size={18} />}
          </button>
          {/* Recording toggle */}
          <button onClick={toggleRecording} style={{
            width: 44, height: 44, borderRadius: '50%', border: 'none',
            background: isRecording ? 'rgba(240,79,95,0.4)' : 'rgba(255,255,255,0.15)',
            color: isRecording ? '#fff' : 'rgba(255,255,255,0.7)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} title={isRecording ? 'Stop recording' : 'Start recording'}>
            {isRecording ? <Square size={16} /> : <Circle size={18} />}
          </button>
          {isRecording && (
            <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', animation: 'pulse 1.5s infinite' }} />
              REC
            </span>
          )}
          <button onClick={handleEndCall} style={{
            width: 52, height: 52, borderRadius: '50%', border: 'none',
            background: 'var(--danger)', color: '#fff',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} title="End call">
            <PhoneOff size={20} />
          </button>
        </div>
      )}

      {/* Session summary (shown after call ends) */}
      {showSummary && (
        <div style={{
          position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.9)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10,
        }}>
          <div style={{ maxWidth: 460, width: '90%', padding: 24, borderRadius: 16, background: '#0A0A0F', border: '1px solid rgba(255,255,255,0.1)' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 8 }}>Consultation Summary</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
              Call duration: {formatDuration(callDuration)} with {patient?.full_name || 'patient'}
            </div>
            <div className="field">
              <label style={{ color: 'rgba(255,255,255,0.6)' }}>Session notes (optional)</label>
              <textarea
                value={summary}
                onChange={e => setSummary(e.target.value)}
                rows={4}
                placeholder="Enter consultation summary, diagnosis notes, or follow-up instructions…"
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.05)',
                  color: '#fff', fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={handleSaveSummary} className="btn btn-primary" style={{ flex: 1, background: 'var(--teal)', color: '#000' }}>
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
