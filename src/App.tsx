import React, { useState, useEffect, useRef, useCallback } from "react";
import { Mic, MicOff, MessageSquare, X, Send, Volume2 } from "lucide-react";
import {
  AvatarMode,
  AvatarFrameKey,
  LiveConnectionStatus,
  Message,
} from "./types";

const AVATAR_FRAMES: Record<AvatarFrameKey, { src: string; label: string }> = {
  base: {
    src: "/assets/aistudio/FLO_body_2a25ba3d.png",
    label: "Idle / Smile",
  },
  talk_mid: {
    src: "/assets/aistudio/flo_talk_mid.png",
    label: "Speak (Mid)",
  },
  talk_open: {
    src: "/assets/aistudio/flo_talk_open.png",
    label: "Speak (Wide)",
  },
  talk_o: {
    src: "/assets/aistudio/flo_talk_o.png",
    label: "Speak (O)",
  },
  listening: {
    src: "/assets/aistudio/flo_listening.png",
    label: "Listening / Blink",
  },
  thinking: {
    src: "/assets/aistudio/flo_thinking.png",
    label: "Thinking",
  },
};

// Convert Float32 [-1..1] audio samples to base64 16-bit little-endian PCM
function float32ToBase64Pcm16(float32Array: Float32Array): string {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const bytes = new Uint8Array(int16Array.buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Convert base64 16-bit little-endian PCM to Float32Array for 24kHz playback
function base64Pcm16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

export default function App() {
  const [connectionStatus, setConnectionStatus] =
    useState<LiveConnectionStatus>("disconnected");
  const [avatarMode, setAvatarMode] = useState<AvatarMode>("idle");
  const [currentFrame, setCurrentFrame] = useState<AvatarFrameKey>("base");
  const [manualFrameOverride, setManualFrameOverride] =
    useState<AvatarFrameKey | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [textInput, setTextInput] = useState("");
  const [isSendingText, setIsSendingText] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Refs for real-time audio & choppy animation loop to avoid stale closures
  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const avatarModeRef = useRef<AvatarMode>("idle");
  const manualOverrideRef = useRef<AvatarFrameKey | null>(null);
  const micRmsRef = useRef<number>(0);
  const tickCountRef = useRef<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Accumulators for live streaming voice transcripts
  const liveUserTranscriptRef = useRef<string>("");
  const liveModelTranscriptRef = useRef<string>("");

  useEffect(() => {
    avatarModeRef.current = avatarMode;
  }, [avatarMode]);

  useEffect(() => {
    manualOverrideRef.current = manualFrameOverride;
  }, [manualFrameOverride]);

  // Preload all expression frames so choppy swaps have zero flicker
  useEffect(() => {
    Object.values(AVATAR_FRAMES).forEach((frame) => {
      const img = new Image();
      img.src = frame.src;
    });
  }, []);

  useEffect(() => {
    if (chatOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, chatOpen]);

  // Ensure output 24kHz AudioContext + AnalyserNode are initialized
  const getOutputAudioSystem = useCallback(() => {
    if (!outputAudioCtxRef.current) {
      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AudioCtx({ sampleRate: 24000 });
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.2;
      analyser.connect(ctx.destination);
      outputAudioCtxRef.current = ctx;
      outputAnalyserRef.current = analyser;
    }
    if (outputAudioCtxRef.current.state === "suspended") {
      outputAudioCtxRef.current.resume().catch(() => {});
    }
    return {
      ctx: outputAudioCtxRef.current,
      analyser: outputAnalyserRef.current!,
    };
  }, []);

  // Stop all currently scheduled output audio chunks (e.g. on interruption or mic stop)
  const stopOutputPlayback = useCallback(() => {
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
        src.disconnect();
      } catch {}
    });
    activeSourcesRef.current.clear();
    if (outputAudioCtxRef.current) {
      nextStartTimeRef.current = outputAudioCtxRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }
  }, []);

  // Schedule a 24kHz Float32 audio chunk for gapless playback and connect to AnalyserNode
  const schedulePcm24kChunk = useCallback(
    (samples: Float32Array) => {
      const { ctx, analyser } = getOutputAudioSystem();
      const audioBuffer = ctx.createBuffer(1, samples.length, 24000);
      audioBuffer.getChannelData(0).set(samples);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(analyser);

      const now = ctx.currentTime;
      const startTime = Math.max(now + 0.01, nextStartTimeRef.current);
      nextStartTimeRef.current = startTime + audioBuffer.duration;

      activeSourcesRef.current.add(source);
      setAvatarMode("speaking");

      source.onended = () => {
        activeSourcesRef.current.delete(source);
        if (activeSourcesRef.current.size === 0) {
          // Return to listening if Live WebSocket is active, otherwise idle
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            setAvatarMode("listening");
          } else {
            setAvatarMode("idle");
          }
        }
      };

      source.start(startTime);
    },
    [getOutputAudioSystem]
  );

  // Play a complete WAV base64 buffer (used for typed chat fallback when Live mic is off)
  const playWavBase64 = useCallback(
    async (wavBase64: string) => {
      try {
        const { ctx, analyser } = getOutputAudioSystem();
        stopOutputPlayback();
        const binary = atob(wavBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const decodedBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = decodedBuffer;
        source.connect(analyser);

        activeSourcesRef.current.add(source);
        setAvatarMode("speaking");

        source.onended = () => {
          activeSourcesRef.current.delete(source);
          if (activeSourcesRef.current.size === 0) {
            setAvatarMode(
              wsRef.current?.readyState === WebSocket.OPEN
                ? "listening"
                : "idle"
            );
          }
        };
        source.start(0);
      } catch (e) {
        console.warn("Could not play WAV audio:", e);
        setAvatarMode("idle");
      }
    },
    [getOutputAudioSystem, stopOutputPlayback]
  );

  // CHOPPY STOP-MOTION ANIMATION SEQUENCER (~7 FPS / 145ms per discrete frame step)
  useEffect(() => {
    const timeDomainBuf = new Uint8Array(256);

    const interval = window.setInterval(() => {
      tickCountRef.current += 1;
      const tick = tickCountRef.current;

      if (manualOverrideRef.current) {
        setCurrentFrame(manualOverrideRef.current);
        return;
      }

      const mode = avatarModeRef.current;

      if (mode === "speaking" && outputAnalyserRef.current) {
        outputAnalyserRef.current.getByteTimeDomainData(timeDomainBuf);
        let sumSq = 0;
        for (let i = 0; i < timeDomainBuf.length; i++) {
          const norm = (timeDomainBuf[i] - 128) / 128;
          sumSq += norm * norm;
        }
        const rms = Math.sqrt(sumSq / timeDomainBuf.length);

        // Intentionally choppy, flipbook-style viseme stepping
        if (rms < 0.018) {
          setCurrentFrame("base");
        } else if (rms < 0.055) {
          setCurrentFrame(tick % 3 === 0 ? "talk_o" : "talk_mid");
        } else if (rms < 0.11) {
          setCurrentFrame(tick % 2 === 0 ? "talk_mid" : "talk_open");
        } else {
          setCurrentFrame(tick % 4 === 0 ? "talk_o" : "talk_open");
        }
        return;
      }

      if (mode === "thinking") {
        // Alternate slightly between thinking and an attentive blink every ~1.2s
        setCurrentFrame(tick % 9 === 0 ? "listening" : "thinking");
        return;
      }

      if (mode === "listening") {
        // React when user's voice hits the microphone or blink warmly every few beats
        if (micRmsRef.current > 0.035) {
          setCurrentFrame(tick % 3 === 0 ? "listening" : "base");
        } else {
          setCurrentFrame(tick % 12 === 0 || tick % 12 === 1 ? "listening" : "base");
        }
        return;
      }

      // Idle mode: mostly base smile with an occasional crisp stop-motion blink
      setCurrentFrame(tick % 26 === 0 ? "listening" : "base");
    }, 145);

    return () => window.clearInterval(interval);
  }, []);

  // Cleanly tear down microphone capture and WebSocket connection
  const stopLiveSession = useCallback(() => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch {}
      processorRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      try {
        inputAudioCtxRef.current.close();
      } catch {}
      inputAudioCtxRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }
    stopOutputPlayback();
    micRmsRef.current = 0;
    setConnectionStatus("disconnected");
    setAvatarMode("idle");
  }, [stopOutputPlayback]);

  // Start real-time microphone capture + Gemini Live WebSocket streaming
  const startLiveSession = useCallback(async () => {
    setErrorBanner(null);
    setManualFrameOverride(null);
    setConnectionStatus("connecting");
    setAvatarMode("thinking");

    try {
      // Initialize output AudioContext inside user gesture
      getOutputAudioSystem();

      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      });
      micStreamRef.current = micStream;

      const AudioCtx =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const inputCtx = new AudioCtx({ sampleRate: 16000 });
      inputAudioCtxRef.current = inputCtx;

      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${window.location.host}/live`);
      wsRef.current = ws;

      ws.onopen = () => {
        const source = inputCtx.createMediaStreamSource(micStream);
        const processor = inputCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (event) => {
          const inputChannel = event.inputBuffer.getChannelData(0);
          // Calculate user microphone RMS to trigger attentive listening frames
          let sum = 0;
          for (let i = 0; i < inputChannel.length; i++) {
            sum += inputChannel[i] * inputChannel[i];
          }
          const rms = Math.sqrt(sum / inputChannel.length);
          micRmsRef.current = rms;

          if (ws.readyState === WebSocket.OPEN) {
            const base64Audio = float32ToBase64Pcm16(inputChannel);
            ws.send(JSON.stringify({ audio: base64Audio }));
          }
        };

        source.connect(processor);
        processor.connect(inputCtx.destination);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "connected") {
            setConnectionStatus("connected");
            setAvatarMode("listening");
          } else if (msg.type === "audio" && msg.audio) {
            const float32Samples = base64Pcm16ToFloat32(msg.audio);
            schedulePcm24kChunk(float32Samples);
          } else if (msg.type === "interrupted") {
            stopOutputPlayback();
            setAvatarMode("listening");
          } else if (msg.type === "input_transcript" && msg.text) {
            liveUserTranscriptRef.current += msg.text;
            if (msg.finished && liveUserTranscriptRef.current.trim()) {
              const finalUserText = liveUserTranscriptRef.current.trim();
              liveUserTranscriptRef.current = "";
              setMessages((prev) => [
                ...prev,
                {
                  id: "u-" + Date.now(),
                  role: "user",
                  content: finalUserText,
                  timestamp: new Date().toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                },
              ]);
              if (activeSourcesRef.current.size === 0) {
                setAvatarMode("thinking");
              }
            }
          } else if (msg.type === "output_transcript" && msg.text) {
            liveModelTranscriptRef.current += msg.text;
            if (msg.finished && liveModelTranscriptRef.current.trim()) {
              const finalModelText = liveModelTranscriptRef.current.trim();
              liveModelTranscriptRef.current = "";
              setMessages((prev) => [
                ...prev,
                {
                  id: "a-" + Date.now(),
                  role: "assistant",
                  content: finalModelText,
                  timestamp: new Date().toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                },
              ]);
            }
          } else if (msg.type === "turn_complete") {
            if (liveModelTranscriptRef.current.trim()) {
              const leftover = liveModelTranscriptRef.current.trim();
              liveModelTranscriptRef.current = "";
              setMessages((prev) => [
                ...prev,
                {
                  id: "a-" + Date.now(),
                  role: "assistant",
                  content: leftover,
                  timestamp: new Date().toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  }),
                },
              ]);
            }
            if (activeSourcesRef.current.size === 0) {
              setAvatarMode("listening");
            }
          } else if (msg.type === "error") {
            setErrorBanner(msg.message || "Voice connection interrupted.");
            stopLiveSession();
          } else if (msg.type === "closed") {
            stopLiveSession();
          }
        } catch (err) {
          console.error("Failed to process Live WS message:", err);
        }
      };

      ws.onerror = () => {
        setErrorBanner("Could not connect to Live voice server.");
        stopLiveSession();
      };

      ws.onclose = () => {
        stopLiveSession();
      };
    } catch (err: any) {
      console.error("Microphone or Live session error:", err);
      setErrorBanner(
        err?.message || "Microphone access is required for Live voice mode."
      );
      stopLiveSession();
    }
  }, [getOutputAudioSystem, schedulePcm24kChunk, stopLiveSession, stopOutputPlayback]);

  const handleToggleMic = () => {
    if (
      connectionStatus === "connected" ||
      connectionStatus === "connecting"
    ) {
      stopLiveSession();
    } else {
      startLiveSession();
    }
  };

  // Send a typed message from the minimal chat overlay
  const handleSendTextMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = textInput.trim();
    if (!trimmed || isSendingText) return;

    setErrorBanner(null);
    setManualFrameOverride(null);
    getOutputAudioSystem();

    const userMessage: Message = {
      id: "u-" + Date.now(),
      role: "user",
      content: trimmed,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setTextInput("");

    // If Live WebSocket is already active, send text directly into the Live session so Flo speaks back in real time
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setAvatarMode("thinking");
      wsRef.current.send(JSON.stringify({ text: trimmed }));
      return;
    }

    // Otherwise call /api/chat and animate Flo with the returned TTS WAV audio
    setIsSendingText(true);
    setAvatarMode("thinking");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, withAudio: true }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Request failed");
      }

      const assistantMsg: Message = {
        id: "a-" + Date.now(),
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
      };

      setMessages((prev) => [...prev, assistantMsg]);

      if (data.audioWavBase64) {
        await playWavBase64(data.audioWavBase64);
      } else {
        setAvatarMode("idle");
      }
    } catch (err: any) {
      setErrorBanner(err?.message || "Could not reach Flo.");
      setAvatarMode("idle");
    } finally {
      setIsSendingText(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopLiveSession();
    };
  }, [stopLiveSession]);

  const isMicActive =
    connectionStatus === "connected" || connectionStatus === "connecting";

  const statusText =
    manualFrameOverride !== null
      ? `Previewing: ${AVATAR_FRAMES[manualFrameOverride].label}`
      : connectionStatus === "connecting"
      ? "Connecting..."
      : avatarMode === "speaking"
      ? "Speaking"
      : avatarMode === "thinking"
      ? "Thinking..."
      : avatarMode === "listening"
      ? "Listening"
      : "Tap microphone to talk";

  // Subtle discrete step offset for authentic choppy stop-motion character movement
  const frameStepOffset =
    currentFrame === "talk_open"
      ? "translate-y-[-2px]"
      : currentFrame === "thinking"
      ? "translate-y-[-1px] rotate-[-0.5deg]"
      : currentFrame === "listening"
      ? "rotate-[0.5deg]"
      : "translate-y-0";

  return (
    <div className="min-h-screen w-full bg-white text-neutral-950 flex flex-col justify-between items-center select-none relative overflow-hidden">
      {/* Minimal Top Spacing / Subtle Error Notice if any */}
      <div className="w-full max-w-xl px-6 pt-6 flex items-center justify-center min-h-[48px]">
        {errorBanner && (
          <div className="flex items-center gap-3 px-4 py-2 border border-neutral-900 bg-white text-xs font-mono text-neutral-900">
            <span>{errorBanner}</span>
            <button
              onClick={() => setErrorBanner(null)}
              className="p-1 hover:bg-neutral-100"
              aria-label="Dismiss notice"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* CENTRAL AVATAR STAGE — Pure white seamless canvas */}
      <main className="flex-1 flex flex-col items-center justify-center px-6 w-full max-w-2xl">
        <div
          onClick={handleToggleMic}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggleMic();
            }
          }}
          aria-label={isMicActive ? "Stop listening" : "Start listening"}
          className="group relative cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900 rounded-2xl p-2"
        >
          <div
            className={`w-64 sm:w-72 md:w-80 aspect-[654/942] bg-white flex items-center justify-center ${frameStepOffset}`}
          >
            <img
              src={AVATAR_FRAMES[currentFrame].src}
              alt={`Flo (${AVATAR_FRAMES[currentFrame].label})`}
              className="w-full h-full object-contain pointer-events-none"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>

        {/* Quiet Minimalist State Caption */}
        <p className="mt-4 font-mono text-xs tracking-wide text-neutral-500 h-5">
          {statusText}
        </p>
      </main>

      {/* BOTTOM MINIMAL CONTROLS — Just Mic & Chat Toggle */}
      <footer className="w-full max-w-md px-6 pb-8 pt-2 flex items-center justify-center gap-4 z-20">
        <button
          onClick={handleToggleMic}
          id="mic-toggle-btn"
          aria-label={isMicActive ? "Mute microphone" : "Listen on microphone"}
          className={`min-h-[52px] min-w-[52px] px-6 py-3 rounded-full border-2 border-neutral-950 font-sans text-sm font-semibold tracking-tight flex items-center justify-center gap-2.5 transition-transform active:scale-95 cursor-pointer whitespace-nowrap shrink-0 ${
            isMicActive
              ? "bg-neutral-950 text-white"
              : "bg-white text-neutral-950 hover:bg-neutral-50"
          }`}
        >
          {isMicActive ? (
            <>
              <MicOff className="w-4 h-4" />
              <span>Stop Listening</span>
            </>
          ) : (
            <>
              <Mic className="w-4 h-4" />
              <span>Listen</span>
            </>
          )}
        </button>

        <button
          onClick={() => setChatOpen((prev) => !prev)}
          id="chat-toggle-btn"
          aria-label={chatOpen ? "Hide text chat" : "Show text chat"}
          title={chatOpen ? "Hide text chat" : "Open minimal text chat"}
          className={`min-h-[52px] min-w-[52px] rounded-full border-2 border-neutral-950 flex items-center justify-center transition-transform active:scale-95 cursor-pointer shrink-0 ${
            chatOpen
              ? "bg-neutral-950 text-white"
              : "bg-white text-neutral-950 hover:bg-neutral-50"
          }`}
        >
          {chatOpen ? (
            <X className="w-4 h-4" />
          ) : (
            <MessageSquare className="w-4 h-4" />
          )}
        </button>
      </footer>

      {/* MINIMAL SLIDE-OVER CHAT & EXPRESSION DRAWER (Only visible when toggled) */}
      {chatOpen && (
        <aside className="fixed inset-y-0 right-0 z-30 w-full sm:w-96 bg-white border-l-2 border-neutral-950 flex flex-col justify-between">
          {/* Drawer Header */}
          <div className="px-5 py-4 border-b border-neutral-200 flex items-center justify-between">
            <span className="font-sans text-sm font-semibold text-neutral-950">
              Text & Frames
            </span>
            <button
              onClick={() => setChatOpen(false)}
              className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-full hover:bg-neutral-100 text-neutral-700 cursor-pointer"
              aria-label="Close chat drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Expression Set Tester Strip (Allows inspecting Flo's choppy animation frames) */}
          <div className="px-5 py-3 border-b border-neutral-200 bg-neutral-50/60">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-neutral-600">
                Expression Frames
              </span>
              {manualFrameOverride && (
                <button
                  onClick={() => setManualFrameOverride(null)}
                  className="text-xs font-mono underline text-neutral-900 cursor-pointer"
                >
                  Auto Animate
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(Object.keys(AVATAR_FRAMES) as AvatarFrameKey[]).map((key) => {
                const isSelected =
                  manualFrameOverride === key ||
                  (!manualFrameOverride && currentFrame === key);
                return (
                  <button
                    key={key}
                    onClick={() =>
                      setManualFrameOverride(
                        manualFrameOverride === key ? null : key
                      )
                    }
                    className={`px-2 py-1.5 text-[11px] font-mono border text-left truncate transition-colors cursor-pointer whitespace-nowrap ${
                      isSelected
                        ? "border-neutral-950 bg-neutral-950 text-white"
                        : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-950"
                    }`}
                  >
                    {AVATAR_FRAMES[key].label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Minimal Transcript Feed */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4 select-text">
            {messages.length === 0 ? (
              <p className="text-xs text-neutral-400 font-sans leading-relaxed">
                Speak with Flo using the microphone or type a short note below.
              </p>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex flex-col ${
                    msg.role === "user" ? "items-end" : "items-start"
                  }`}
                >
                  <div className="flex items-center gap-1.5 mb-1 text-[11px] text-neutral-400">
                    <span>{msg.role === "user" ? "You" : "Flo"}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono">{msg.timestamp}</span>
                  </div>
                  <div
                    className={`max-w-[85%] px-3.5 py-2.5 text-sm leading-relaxed border ${
                      msg.role === "user"
                        ? "bg-neutral-950 text-white border-neutral-950"
                        : "bg-white text-neutral-900 border-neutral-900"
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Minimal Text Input Form */}
          <form
            onSubmit={handleSendTextMessage}
            className="p-4 border-t border-neutral-200 bg-white flex items-center gap-2"
          >
            <input
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Write to Flo..."
              disabled={isSendingText}
              className="flex-1 min-w-0 px-3.5 py-2.5 text-sm border border-neutral-900 bg-white text-neutral-950 focus:outline-none"
            />
            <button
              type="submit"
              disabled={isSendingText || !textInput.trim()}
              aria-label="Send message"
              className="min-h-[42px] min-w-[42px] px-3.5 py-2.5 border border-neutral-950 bg-neutral-950 text-white disabled:opacity-30 flex items-center justify-center cursor-pointer shrink-0"
            >
              {isSendingText ? (
                <Volume2 className="w-4 h-4 animate-pulse" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
          </form>
        </aside>
      )}
    </div>
  );
}
