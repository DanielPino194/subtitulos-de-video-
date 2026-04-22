/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback, ChangeEvent } from 'react';
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
  FileVideo,
  Upload,
  Info
} from 'lucide-react';

// --- Constantes ---
const SAMPLE_RATE = 16000;
const FRAME_RATE = 2; 
const DEFAULT_TARGET_LANG = 'Español Latino';

type SourceType = 'camera' | 'screen' | 'file';

export default function App() {
  const [isActive, setIsActive] = useState(false);
  const [targetLang, setTargetLang] = useState(DEFAULT_TARGET_LANG);
  const [currentModelText, setCurrentModelText] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const currentModelTextRef = useRef("");
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);
  const [sourceType, setSourceType] = useState<SourceType>('camera');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  
  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaElementSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  
  const [logs, setLogs] = useState<string[]>([]);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isAudioContextReady, setIsAudioContextReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  
  const addLog = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 5));
  };

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

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSelectedFile(file);
      setStatusMessage("Video cargado. Presiona 'GENERAR' botón abajo.");
      setCurrentModelText(""); // Limpiar cualquier texto previo de IA
      addLog("Archivo cargado: " + file.name);
      if (videoRef.current) {
        const url = URL.createObjectURL(file);
        videoRef.current.srcObject = null; 
        videoRef.current.src = url;
        videoRef.current.load();
        mediaElementSourceRef.current = null;
      }
    }
  };

  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: SAMPLE_RATE
      });
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    setIsAudioContextReady(true);
    // Play a tiny beep to unlock
    const osc = audioContextRef.current.createOscillator();
    const gain = audioContextRef.current.createGain();
    gain.gain.value = 0.01;
    osc.connect(gain);
    gain.connect(audioContextRef.current.destination);
    osc.start();
    osc.stop(audioContextRef.current.currentTime + 0.1);
  };

  const [isRecording, setIsRecording] = useState(false);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mixedAudioDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);

  const startRecording = (canvasStream: MediaStream, audioStream: MediaStream) => {
    try {
      const combinedStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...audioStream.getAudioTracks()
      ]);
      
      const recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm' });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        setRecordedUrl(url);
        addLog("¡Video listo para descargar!");
      };
      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
    } catch (e) {
      addLog("Error al iniciar grabación.");
    }
  };

  const [isConnecting, setIsConnecting] = useState(false);

  // Loop de Renderizado Continuo (Preview + Recording)
  useEffect(() => {
    let animationId: number;
    
    const renderFrame = () => {
      if (!videoRef.current || !canvasRef.current) {
        animationId = requestAnimationFrame(renderFrame);
        return;
      }

      const canvas = canvasRef.current;
      const video = videoRef.current;
      const ctx = canvas.getContext('2d');

      if (ctx && (video.readyState >= 2 || video.srcObject)) {
        // Reset state
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        
        // 1. Dibujar el frame del video
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // 2. Si hay sesión activa y texto de IA, quemarlo
        const textToDraw = currentModelTextRef.current;
        if (isActive && textToDraw) {
          const padding = 40;
          const fontSize = 32;
          ctx.font = `bold ${fontSize}px sans-serif`;
          
          const text = textToDraw.toUpperCase();
          const textMetrics = ctx.measureText(text);
          const boxWidth = textMetrics.width + padding * 2;
          const boxHeight = fontSize + padding;
          
          const x = (canvas.width - boxWidth) / 2;
          const y = canvas.height - 100;

          // Fondo (Rectangle simple para compatibilidad)
          ctx.fillStyle = 'white';
          ctx.fillRect(x, y, boxWidth, boxHeight);
          
          // Borde
          ctx.strokeStyle = '#dc2626';
          ctx.lineWidth = 4;
          ctx.strokeRect(x, y, boxWidth, boxHeight);

          // Texto
          ctx.fillStyle = 'black';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, canvas.width / 2, y + boxHeight / 2);
        }
      }
      animationId = requestAnimationFrame(renderFrame);
    };

    renderFrame();
    return () => cancelAnimationFrame(animationId);
  }, [isActive]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (currentModelText) {
      timer = setTimeout(() => {
        setCurrentModelText("");
        currentModelTextRef.current = "";
      }, 5000);
    }
    return () => clearTimeout(timer);
  }, [currentModelText]);

  const stopSession = useCallback((reason?: string) => {
    setIsActive(false);
    setIsConnecting(false);
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    setIsRecording(false);
    
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
    }
    setAudioLevel(0);
    setIsAiSpeaking(false);
    addLog(reason ? `Fin sesión: ${reason}` : "Sesión terminada.");
  }, []);

  const startSession = async () => {
    try {
      setIsConnecting(true);
      setRecordedUrl(null);
      setCurrentModelText(""); 
      currentModelTextRef.current = "";
      await initAudio();
      
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      let stream: MediaStream | null = null;
      
      if (sourceType === 'screen') {
        stream = await (navigator.mediaDevices as any).getDisplayMedia({
          video: { cursor: "always" },
          audio: true 
        });
      } else if (sourceType === 'camera') {
        stream = await navigator.mediaDevices.getUserMedia({
          video: isCameraOn ? { width: 1280, height: 720 } : false,
          audio: isMicOn
        });
      }
      
      if (stream) {
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      }

      const audioCtx = audioContextRef.current!;
      mixedAudioDestRef.current = audioCtx.createMediaStreamDestination();

      if (sourceType === 'file' && videoRef.current) {
        videoRef.current.currentTime = 0;
        await videoRef.current.play();
      }

      // Conexión Live Optimizada
      const sessionPromise = ai.live.connect({
        model: "gemini-2.0-flash-exp", 
        config: {
          responseModalities: [Modality.AUDIO], 
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Charon" } }
          },
          systemInstruction: `Eres un traductor simultáneo. 
          Escucha el audio y tradúcelo al español latino. 
          Responde solo con la traducción.`,
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
             setIsConnecting(false);
             setIsActive(true);
             addLog("IA Conectada.");
             
             setCurrentModelText("GRABANDO - TRADUCIENDO...");
             currentModelTextRef.current = "GRABANDO - TRADUCIENDO...";
             setTimeout(() => {
               setCurrentModelText("");
               currentModelTextRef.current = "";
             }, 3000);

             startAudioCapture(audioCtx, stream);
             
             const aiInterval = setInterval(() => {
               if (sessionRef.current && canvasRef.current && isActive) {
                 const data = canvasRef.current.toDataURL('image/jpeg', 0.4).split(',')[1];
                 sessionRef.current.sendRealtimeInput([{
                   inlineData: { data, mimeType: 'image/jpeg' }
                 }]);
               } else {
                 clearInterval(aiInterval);
               }
             }, 500);

             const canvasStream = canvasRef.current!.captureStream(30);
             startRecording(canvasStream, mixedAudioDestRef.current!.stream);
          },
          onmessage: (message: any) => {
             const parts = message.serverContent?.modelTurn?.parts || [];
             if (parts.length > 0) {
               parts.forEach((part: any) => {
                 if (part.inlineData?.data) {
                   setIsAiSpeaking(true);
                   playBufferedAudio(part.inlineData.data);
                   setTimeout(() => setIsAiSpeaking(false), 2000);
                 }
                 if (part.text) {
                   setCurrentModelText(part.text);
                   currentModelTextRef.current = part.text;
                 }
               });
             }
          },
          onclose: () => stopSession("Conexión cerrada"),
          onerror: (err) => {
            console.error(err);
            stopSession(`Fallo: ${err.message || 'Desconocido'}`);
          }
        }
      });

      sessionRef.current = await sessionPromise;
      
    } catch (error: any) {
      addLog("Error: " + error.message);
      stopSession();
    }
  };

  const startAudioCapture = async (audioCtx: AudioContext, stream: MediaStream | null) => {
    let source: AudioNode;

    if (sourceType === 'file' && videoRef.current) {
      if (!mediaElementSourceRef.current) {
        mediaElementSourceRef.current = audioCtx.createMediaElementSource(videoRef.current);
      }
      source = mediaElementSourceRef.current;
      
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = 0.5; // Un poco más de volumen
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      if (mixedAudioDestRef.current) gainNode.connect(mixedAudioDestRef.current);

    } else if (stream) {
      source = audioCtx.createMediaStreamSource(stream);
    } else {
      return;
    }

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyserRef.current = analyser;

    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    source.connect(processor);
    processor.connect(audioCtx.destination);

    processor.onaudioprocess = (e) => {
      if (!sessionRef.current || !isActive) return;
      const inputData = e.inputBuffer.getChannelData(0);
      
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) {
        sum += inputData[i] * inputData[i];
      }
      const lvl = Math.sqrt(sum / inputData.length);
      setAudioLevel(lvl);

      // Capturar audio siempre que haya un mínimo de señal
      if (lvl > 0.005) {
        const base64Data = float32ToInt16Base64(inputData);
        sessionRef.current.sendRealtimeInput([{
          inlineData: { data: base64Data, mimeType: `audio/pcm;rate=${SAMPLE_RATE}` }
        }]);
      }
    };
  };

  const startVideoCapture = () => {
     // Ya manejado por el useEffect global de renderizado
  };

  const playBufferedAudio = (base64Data: string) => {
    if (!audioContextRef.current) return;
    const audioCtx = audioContextRef.current;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const binary = atob(base64Data);
    const buffer = new Int16Array(binary.length / 2);
    for (let i = 0; i < buffer.length; i++) {
        buffer[i] = (binary.charCodeAt(i * 2) & 0xFF) | (binary.charCodeAt(i * 2 + 1) << 8);
    }
    const float32Buffer = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
        float32Buffer[i] = buffer[i] / 32768.0;
    }
    const audioBuffer = audioCtx.createBuffer(1, float32Buffer.length, SAMPLE_RATE);
    audioBuffer.getChannelData(0).set(float32Buffer);
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    
    // Salida Y Mezcla
    source.connect(audioCtx.destination);
    if (mixedAudioDestRef.current) source.connect(mixedAudioDestRef.current);
    source.start();
  };

  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col items-center bg-[#050505] text-white">
      {/* Cabecera Pro */}
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

        <div className="flex flex-wrap justify-center gap-2 p-1.5 bg-black rounded-2xl border border-zinc-800">
          <button 
            onClick={() => setSourceType('camera')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-bold transition-all ${sourceType === 'camera' ? 'bg-red-600 text-white' : 'text-zinc-500 hover:text-white'}`}
          >
            <Camera className="w-4 h-4" /> CÁMARA
          </button>
          <button 
            onClick={() => setSourceType('screen')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-bold transition-all ${sourceType === 'screen' ? 'bg-red-600 text-white' : 'text-zinc-500 hover:text-white'}`}
          >
            <Monitor className="w-4 h-4" /> COMPARTIR PANTALLA
          </button>
          <button 
            onClick={() => setSourceType('file')}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-[10px] font-bold transition-all ${sourceType === 'file' ? 'bg-red-600 text-white' : 'text-zinc-500 hover:text-white'}`}
          >
            <FileVideo className="w-4 h-4" /> SUBIR VIDEO
          </button>
        </div>
      </header>

      {/* Main App */}
      <main className="w-full max-w-5xl flex flex-col gap-6">
        <div className="relative aspect-video bg-zinc-900 rounded-[48px] overflow-hidden border border-zinc-800 shadow-2xl group">
          
          <canvas 
            ref={canvasRef} 
            width={1280} height={720} 
            className="w-full h-full object-cover" 
          />

          <video 
            ref={videoRef} 
            playsInline 
            muted={sourceType !== 'file'}
            crossOrigin="anonymous"
            className="hidden" 
          />
          
          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />

          {/* Texto de Instrucciones cuando NO está activo */}
          {!isActive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm p-10 text-center">
              {isConnecting ? (
                <div className="flex flex-col items-center gap-6">
                  <div className="w-16 h-16 border-4 border-red-600 border-t-white rounded-full animate-spin" />
                  <h2 className="text-xl font-bold uppercase tracking-[0.2em] animate-pulse">Conectando con la IA...</h2>
                  <p className="text-zinc-400 text-[10px] font-mono tracking-widest uppercase">PREPARANDO GRABACIÓN</p>
                </div>
              ) : recordedUrl ? (
                <div className="flex flex-col items-center gap-6">
                  <h2 className="text-3xl font-black uppercase text-white tracking-tighter">¡Proceso Finalizado!</h2>
                  <a 
                    href={recordedUrl} 
                    download="video-traducido.webm"
                    className="px-12 py-6 bg-red-600 hover:bg-red-700 text-white font-black rounded-3xl text-xl shadow-[0_0_50px_rgba(220,38,38,0.5)] transition-all active:scale-95"
                  >
                    DESCARGAR VIDEO CON SUBTÍTULOS
                  </a>
                  <button 
                    onClick={() => setRecordedUrl(null)}
                    className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest hover:text-white underline underline-offset-4"
                  >
                    VOLVER A INTENTAR
                  </button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  <div className="w-20 h-20 bg-zinc-800 rounded-3xl flex items-center justify-center mb-2 border border-zinc-700 shadow-2xl">
                    <Play className="w-10 h-10 text-zinc-500" />
                  </div>
                  <p className="text-lg font-bold uppercase tracking-widest text-white drop-shadow-lg">
                    {selectedFile ? (statusMessage || "Video Cargado y Listo") : "Sube un video para comenzar"}
                  </p>
                  <p className="text-[10px] font-mono text-zinc-500 tracking-[0.2em] uppercase">
                    {selectedFile ? "PULSA EL BOTÓN BLANCO ABAJO" : "ARCHIVOS MP4 / WEBM"}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Indicadores */}
          <div className="absolute top-10 left-10 flex flex-wrap gap-3">
            {isActive && (
              <div className="flex items-center gap-2 px-4 py-2 bg-red-600 rounded-full text-[10px] font-black tracking-widest text-white shadow-xl">
                <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                GRABANDO Y TRADUCIENDO...
              </div>
            )}
            {isAiSpeaking && (
              <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-full text-[10px] font-black tracking-widest text-black shadow-xl">
                IA HABLANDO...
              </div>
            )}
          </div>
          
          {/* File Selection Overlay */}
          {sourceType === 'file' && !selectedFile && (
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/80 cursor-pointer hover:bg-zinc-900/70 transition-colors"
            >
              <Upload className="w-16 h-16 mb-4 text-red-600 animate-bounce" />
              <h2 className="text-xl font-bold uppercase tracking-widest">Seleccionar Archivo de Video</h2>
              <p className="text-zinc-500 text-xs mt-2 font-mono">MP4, WEBM O MOV SOPORTADO</p>
            </div>
          )}

          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept="video/*" 
            className="hidden" 
          />
        </div>

        {/* Nivel de Audio / Diagnóstico */}
        <div className="flex flex-col gap-4 bg-zinc-900/40 p-6 rounded-[32px] border border-zinc-800">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Monitor de Audio (Video Original)</span>
            <span className="text-[10px] font-mono text-zinc-400">{Math.round(audioLevel * 100)}%</span>
          </div>
          <div className="w-full h-3 bg-zinc-950 rounded-full overflow-hidden border border-zinc-800">
            <motion.div 
              animate={{ width: `${Math.min(100, audioLevel * 500)}%` }}
              className={`h-full ${audioLevel > 0.01 ? 'bg-red-600' : 'bg-zinc-800'} transition-colors shadow-[0_0_10px_rgba(220,38,38,0.5)]`}
            />
          </div>
          
          {/* Debug Logs */}
          <div className="mt-4 bg-black/60 p-4 rounded-2xl border border-zinc-800/50 font-mono text-[10px] text-zinc-500">
            <p className="border-b border-zinc-800 pb-2 mb-2 text-zinc-400">HISTORIAL DEL SISTEMA</p>
            {logs.map((log, i) => (
              <p key={i} className={log.startsWith('Traducción') ? 'text-white' : ''}> {">"} {log}</p>
            ))}
          </div>
        </div>

        {/* Controles Principales */}
        <div className="flex flex-col items-center gap-8 mt-4">
          <div className="flex flex-col md:flex-row items-center gap-6">
            {!isActive ? (
              <button 
                onClick={startSession}
                className="group relative flex items-center gap-6 px-16 py-8 bg-white hover:bg-zinc-100 text-black font-black rounded-[40px] transition-all transform active:scale-95 shadow-[0_20px_60px_rgba(255,255,255,0.1)] text-2xl uppercase tracking-tighter"
              >
                <Play className="w-10 h-10 fill-current text-red-600" />
                GENERAR VIDEO TRADUCIDO
                <div className="absolute -inset-1 bg-red-600 rounded-[40px] opacity-0 group-hover:opacity-20 transition-opacity blur-xl" />
              </button>
            ) : (
              <button 
                onClick={stopSession}
                className="flex items-center gap-6 px-16 py-8 bg-red-600 text-white font-black rounded-[40px] transition-all transform active:scale-95 text-2xl uppercase tracking-tighter shadow-[0_20px_60px_rgba(220,38,38,0.3)]"
              >
                <Square className="w-10 h-10 fill-current" />
                FINALIZAR GRABACIÓN
              </button>
            )}

            {!isAudioContextReady && (
              <button 
                onClick={initAudio}
                className="px-8 py-3 bg-zinc-800 hover:bg-zinc-700 text-white rounded-2xl text-[10px] font-black tracking-widest transition-all"
              >
                HABILITAR SONIDO (CLICK OBLIGATORIO)
              </button>
            )}
          </div>
        </div>
      </main>

      <footer className="mt-auto py-10 flex flex-col items-center gap-2 border-t border-zinc-900 w-full max-w-5xl">
        <div className="flex gap-8 text-[10px] font-mono text-zinc-600 tracking-widest uppercase">
          <span>Latin Spanish v2.2</span>
          <span>•</span>
          <span>Fixed Audio Routing</span>
          <span>•</span>
          <span>Diagnostic Mode: ON</span>
        </div>
      </footer>
    </div>
  );
}
