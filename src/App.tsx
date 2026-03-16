import { useState, useEffect, useRef } from 'react';
import { Play, Square, Copy, CheckCircle2, XCircle, Loader2, Search } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [apiKey, setApiKey] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [status, setStatus] = useState('Idle');
  const [available, setAvailable] = useState<string[]>([]);
  const [taken, setTaken] = useState<string[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const availableEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (availableEndRef.current) {
      availableEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [available]);

  const startChecking = () => {
    if (isChecking) return;
    setIsChecking(true);
    setStatus('Connecting...');
    
    // Clear previous results if starting fresh
    if (status === 'Idle') {
      setAvailable([]);
      setTaken([]);
    }

    const url = new URL('/api/stream-check', window.location.origin);
    if (apiKey) {
      url.searchParams.set('apiKey', apiKey);
    }

    const eventSource = new EventSource(url.toString());
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'status') {
          setStatus(data.message);
        } else if (data.type === 'result') {
          if (data.available) {
            setAvailable(prev => [...prev, data.username]);
          } else {
            setTaken(prev => [...prev, data.username]);
          }
        } else if (data.type === 'error') {
          setStatus(`Error: ${data.message}`);
        } else if (data.type === 'fatal-error') {
          setStatus(`Rate Limit: ${data.message}`);
          if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
          }
          setIsChecking(false);
        }
      } catch (err) {
        console.error('Failed to parse SSE message', err);
      }
    };

    eventSource.onerror = (err) => {
      console.error('SSE Error', err);
      setStatus('Connection lost. Reconnecting...');
    };
  };

  const stopChecking = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setIsChecking(false);
    setStatus('Stopped');
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      <div className="max-w-5xl mx-auto p-6 md:p-12">
        
        {/* Header */}
        <header className="mb-12 text-center md:text-left">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4 bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-transparent">
            Gmail Username Discoverer
          </h1>
          <p className="text-zinc-400 text-lg max-w-2xl">
            Automatically generate and verify developer-focused Gmail usernames using Gemini AI. 
            Finds combinations of Nature, Tech, and Anime themes with code extensions (e.g., earth.js, pika.go).
          </p>
        </header>

        {/* Controls */}
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-6 mb-8 backdrop-blur-sm">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col md:flex-row gap-4 items-end">
              
              <div className="flex-1 w-full">
                <label htmlFor="apiKey" className="block text-sm font-medium text-zinc-400 mb-2">
                  Gemini API Key (Optional)
                </label>
                <input
                  id="apiKey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={isChecking}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl py-3 px-4 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 disabled:opacity-50 transition-all font-mono text-sm"
                  placeholder="AIzaSy..."
                />
              </div>
              
              <div className="flex gap-3 w-full md:w-auto">
                {!isChecking ? (
                  <button
                    onClick={startChecking}
                    className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 font-semibold py-3 px-6 rounded-xl transition-all active:scale-95"
                  >
                    <Play className="w-5 h-5 fill-current" />
                    Start Search
                  </button>
                ) : (
                  <button
                    onClick={stopChecking}
                    className="flex-1 md:flex-none flex items-center justify-center gap-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-500 border border-rose-500/20 font-semibold py-3 px-6 rounded-xl transition-all active:scale-95"
                  >
                    <Square className="w-5 h-5 fill-current" />
                    Stop Search
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Status Bar */}
          <div className="mt-6 flex items-center gap-4 text-sm bg-zinc-950/50 rounded-lg p-3 border border-zinc-800/50">
            <div className="flex items-center gap-2 text-zinc-400">
              {isChecking ? <Loader2 className="w-4 h-4 animate-spin text-emerald-500" /> : <div className="w-2 h-2 rounded-full bg-zinc-600" />}
              <span className="font-mono">{status}</span>
            </div>
            <div className="h-4 w-px bg-zinc-800 mx-2" />
            <div className="flex gap-6 text-zinc-400">
              <div>Checked: <span className="text-zinc-100 font-mono">{available.length + taken.length}</span></div>
              <div>Available: <span className="text-emerald-400 font-mono">{available.length}</span></div>
            </div>
          </div>
        </div>

        {/* Results Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          
          {/* Available */}
          <div className="flex flex-col h-[600px]">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircle2 className="w-5 h-5 text-emerald-500" />
              <h2 className="text-xl font-semibold text-zinc-100">Available</h2>
              <span className="ml-auto bg-emerald-500/10 text-emerald-400 py-1 px-2 rounded-md text-xs font-mono">
                {available.length} found
              </span>
            </div>
            
            <div className="flex-1 bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4 overflow-y-auto custom-scrollbar">
              {available.length === 0 ? (
                <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
                  {isChecking ? 'Searching for available usernames...' : 'No usernames found yet.'}
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2">
                  {available.map((username, i) => (
                    <div 
                      key={`${username}-${i}`}
                      className="group flex items-center justify-between bg-zinc-950 border border-emerald-500/20 hover:border-emerald-500/50 rounded-xl p-3 transition-colors"
                    >
                      <span className="font-mono text-emerald-400 text-lg">{username}</span>
                      <button
                        onClick={() => copyToClipboard(username)}
                        className="p-2 text-zinc-500 hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
                        title="Copy username"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  <div ref={availableEndRef} />
                </div>
              )}
            </div>
          </div>

          {/* Taken */}
          <div className="flex flex-col h-[600px]">
            <div className="flex items-center gap-2 mb-4">
              <XCircle className="w-5 h-5 text-rose-500" />
              <h2 className="text-xl font-semibold text-zinc-100">Taken</h2>
              <span className="ml-auto bg-rose-500/10 text-rose-400 py-1 px-2 rounded-md text-xs font-mono">
                {taken.length} checked
              </span>
            </div>
            
            <div className="flex-1 bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-4 overflow-y-auto custom-scrollbar">
              {taken.length === 0 ? (
                <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
                  {isChecking ? 'Checking usernames...' : 'No taken usernames yet.'}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 content-start">
                  {taken.map((username, i) => (
                    <div 
                      key={`${username}-${i}`}
                      className="bg-zinc-950 border border-zinc-800 text-zinc-500 rounded-lg px-3 py-1.5 text-sm font-mono"
                    >
                      {username}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
