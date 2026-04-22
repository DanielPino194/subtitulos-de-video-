/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import { motion, AnimatePresence } from 'motion/react';
import { 
  Mic, 
  MicOff, 
  Video, 
  VideoOff, 
  Languages, 
  Play, 
  Square,
  Monitor,
  Camera,
  Info
} from 'lucide-react';

// --- Constantes ---
const SAMPLE_RATE = 16000;
const FRAME_RATE = 2; 
const DEFAULT_TARGET_LANG = 'Español Latino';

export default function App() {
  const [isActive, setIsActive] = useState(false);
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET_LANG);
  const [currentModelText, setCurrentModelText] = useState("");
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [useScreenCapture, setUseScreenCapture] = useState(false);
  
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  
  // --- Utilidades de Audio ---
  const float32ToInt16Base64 = (buffer: Float32Array) => {
    const int16Buffer = new Int16Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        const s = Math.max(-1, Math.min(1, buffer[i]));
        int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const binary = String.fromCharCode(...new Uint8Array(int16Buffer.buffer));
    return btoa(binary);
  };

  const stopSession = useCallback(() => {
    setIsActive(false);
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCurrentModelText("");
  }, []);

  const startSession = async () => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      
      let stream: MediaStream;
      
      if (useScreenCapture) {
        // Capture screen/tab (useful for YouTube/X)
        stream = await (navigator.mediaDevices as any).getDisplayMedia({
          video: { cursor: "always" },
          audio: true // Captures system/tab audio
        });
      } else {
        // Default camera/mic
        stream = await navigator.mediaDevices.getUserMedia({
          video: isCameraOn ? { width: 1280, height: 720 } : false,
          audio: isMicOn
        });
      }
      
      streamRef.current = stream;
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: SAMPLE_RATE
      });
      audioContextRef.current = audioCtx;

      const sessionPromise = ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } }
          },
          systemInstruction: `Eres un traductor y subtitulador profesional. 
          Traduce todo el contenido (especialmente de videos de YouTube o X) que escuches o veas en pantalla.
          Idioma de origen habitual: Inglés.
          Idioma de destino: ${targetLang}.
          Responde EXCLUSIVAMENTE con la traducción en voz y asegúrate de proporcionar el texto traducido para los subtítulos.
          Sé extremadamente rápido y preciso.`,
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setIsActive(true);
            startAudioCapture(audioCtx, stream);
            startVideoCapture();
          },
          onmessage: async (message) => {
            if (message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
              playBufferedAudio(message.serverContent.modelTurn.parts[0].inlineData.data);
            }
            const modelTranscription = message.serverContent?.modelTurn?.parts?.find(p => p.text)?.text;
            if (modelTranscription) {
               setCurrentModelText(modelTranscription);
            }
          },
          onclose: () => stopSession(),
          onerror: () => stopSession()
        }
      });
      
      sessionRef.current = await sessionPromise;
      
    } catch (error) {
      console.error(error);
      alert("Error al iniciar. Asegúrate de dar permisos y elegir una fuente de video válida.");
      stopSession();
    }
  };

  const startAudioCapture = async (audioCtx: AudioContext, stream: MediaStream) => {
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);

    processor.onaudioprocess = (e) => {
      if (!isActive || !sessionRef.current) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const base64Data = float32ToInt16Base64(inputData);
      sessionRef.current.sendRealtimeInput({
        audio: { data: base64Data, mimeType: `audio/pcm;rate=${SAMPLE_RATE}` }
      });
    };
  };

  const startVideoCapture = () => {
    const interval = setInterval(() => {
      if (!isActive || !sessionRef.current || !videoRef.current || !canvasRef.current) {
        if (!isActive) clearInterval(interval);
        return;
      }
      const canvas = canvasRef.current;
      const video = videoRef.current;
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const base64Data = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
        sessionRef.current.sendRealtimeInput({
          video: { data: base64Data, mimeType: 'image/jpeg' }
        });
      }
    }, 1000 / FRAME_RATE);
  };

  const playBufferedAudio = (base64Data: string) => {
    if (!audioContextRef.current) return;
    const binary = atob(base64Data);
    const buffer = new Int16Array(binary.length / 2);
    for (let i = 0; i < buffer.length; i++) {
        buffer[i] = (binary.charCodeAt(i * 2) & 0xFF) | (binary.charCodeAt(i * 2 + 1) << 8);
    }
    const float32Buffer = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        float32Buffer[i] = buffer[i] / 32768.0;
    }
    const audioBuffer = audioContextRef.current.createBuffer(1, float32Buffer.length, SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32Buffer);
    const source = audioContextRef.current.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContextRef.current.destination);
    source.start();
  };

  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col items-center bg-[#050505] text-white">
      {/* Cabecera Modular */}
      <header className="w-full max-w-5xl flex flex-col md:flex-row justify-between items-center mb-8 gap-6 bg-zinc-900/40 p-6 rounded-[32px] border border-zinc-800/50 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className="w-14 h-14 bg-red-600 rounded-2xl flex items-center justify-center shadow-[0_0_30px_rgba(220,38,38,0.4)]">
            <Languages className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-black tracking-tight uppercase">Translator <span className="text-red-500">Pro</span></h1>
            <p className="text-[10px] text-zinc-500 font-mono tracking-[0.3em]">LATAM SPANISH EDITION</p>
          </div>
        </div>

        <div className="flex gap-2 p-1.5 bg-black rounded-2xl border border-zinc-800">
          <button 
            onClick={() => setUseScreenCapture(false)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all ${!useScreenCapture ? 'bg-red-600 text-white' : 'text-zinc-500 hover:text-white'}`}
          >
            <Camera className="w-4 h-4" /> CÁMARA
          </button>
          <button 
            onClick={() => setUseScreenCapture(true)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold transition-all ${useScreenCapture ? 'bg-red-600 text-white' : 'text-zinc-500 hover:text-white'}`}
          >
            <Monitor className="w-4 h-4" /> PANTALLA / VIDEO
          </button>
        </div>
      </header>

      {/* Main App */}
      <main className="w-full max-w-5xl flex flex-col gap-6">
        <div className="relative aspect-video bg-zinc-900 rounded-[48px] overflow-hidden border border-zinc-800 shadow-2xl group">
          <video 
            ref={videoRef} 
            autoPlay 
            muted 
            playsInline 
            className="w-full h-full object-cover"
          />
          
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

          {/* Subtítulos de Alto Contraste */}
          <AnimatePresence>
            {currentModelText && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="absolute bottom-16 left-0 right-0 px-12 text-center z-50"
              >
                <div className="inline-block bg-white text-black px-8 py-5 rounded-[24px] shadow-[0_20px_50px_rgba(0,0,0,0.5)] border-4 border-red-600">
                  <p className="text-2xl md:text-3xl font-black leading-tight uppercase italic tracking-tighter">
                    {currentModelText}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Indicadores de Estado */}
          <div className="absolute top-10 left-10 flex items-center gap-3">
            {isActive && (
              <div className="flex items-center gap-2 px-4 py-2 bg-red-600 rounded-full text-[10px] font-black tracking-widest text-white shadow-xl">
                <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                TRANSLATING LIVE
              </div>
            )}
            <div className="px-4 py-2 bg-zinc-900/90 border border-zinc-700 rounded-full text-[10px] font-black tracking-widest text-zinc-400">
              {useScreenCapture ? 'SOURCE: SCREEN_CAPTURE' : 'SOURCE: DEVICE_CAMERA'}
            </div>
          </div>
          
          <canvas ref={canvasRef} width={1280} height={720} className="hidden" />
        </div>

        {/* Botón de Acción Principal */}
        <div className="flex flex-col items-center gap-8 mt-4">
          {!isActive ? (
            <button 
              onClick={startSession}
              className="group relative flex items-center gap-6 px-16 py-8 bg-white hover:bg-zinc-100 text-black font-black rounded-[40px] transition-all transform active:scale-95 shadow-[0_20px_60px_rgba(255,255,255,0.1)] text-2xl uppercase tracking-tighter"
            >
              <Play className="w-10 h-10 fill-current text-red-600" />
              CONECTAR Y TRADUCIR
              <div className="absolute -inset-1 bg-red-600 rounded-[40px] opacity-0 group-hover:opacity-20 transition-opacity blur-xl" />
            </button>
          ) : (
            <button 
              onClick={stopSession}
              className="flex items-center gap-6 px-16 py-8 bg-red-600 text-white font-black rounded-[40px] transition-all transform active:scale-95 text-2xl uppercase tracking-tighter shadow-[0_20px_60px_rgba(220,38,38,0.3)]"
            >
              <Square className="w-10 h-10 fill-current" />
              DESCONECTAR
            </button>
          )}

          <div className="flex items-center gap-10 opacity-30">
            <div className="flex items-center gap-2">
              <Info className="w-4 h-4" />
              <span className="text-[10px] font-mono uppercase tracking-[0.2em]">Soporta Videos de YouTube & X vía compartir pestaña</span>
            </div>
          </div>
        </div>
      </main>

      <footer className="mt-auto py-10 flex flex-col items-center gap-2 border-t border-zinc-900 w-full max-w-5xl">
        <div className="flex gap-8 text-[10px] font-mono text-zinc-600 tracking-widest uppercase">
          <span>Latin Spanish v2.0</span>
          <span>•</span>
          <span>Engine: Gemini 3.1 Live</span>
          <span>•</span>
          <span>Latencia: ~250ms</span>
        </div>
      </footer>
    </div>
  );
}
