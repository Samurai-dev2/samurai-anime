// src/pages/TestStreamPage.tsx
// Add route in App.tsx: <Route path="/test-stream" element={<TestStreamPage />} />
// Visit: /test-stream to debug

import { useState } from "react";

export default function TestStreamPage() {
  const [title,   setTitle]   = useState("Naruto");
  const [episode, setEpisode] = useState("1");
  const [season,  setSeason]  = useState("1");
  const [result,  setResult]  = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [proxyResult, setProxyResult] = useState<string>("");

  // Step 1: Test the stream API
  async function testStream() {
    setLoading(true);
    setResult(null);
    setProxyResult("");
    try {
      const res = await fetch(
        `/api/stream?title=${encodeURIComponent(title)}&episode=${episode}&season=${season}&lang=sub`
      );
      const data = await res.json();
      setResult(data);
    } catch (e: any) {
      setResult({ error: e.message });
    }
    setLoading(false);
  }

  // Step 2: Test the proxy URL that stream returned
  async function testProxy() {
    if (!result?.url) return;
    setProxyResult("Loading...");
    try {
      const res = await fetch(result.url);
      const text = await res.text();
      setProxyResult(
        `Status: ${res.status}\nContent-Type: ${res.headers.get("content-type")}\n\n${text.slice(0, 2000)}`
      );
    } catch (e: any) {
      setProxyResult("ERROR: " + e.message);
    }
  }

  return (
    <div className="bg-black min-h-screen text-white p-8 font-mono text-sm">
      <h1 className="text-xl font-bold mb-6 text-red-400">Stream Debugger</h1>

      {/* Controls */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Anime title"
          className="bg-white/10 border border-white/20 rounded px-3 py-2 w-48"
        />
        <input
          value={episode}
          onChange={(e) => setEpisode(e.target.value)}
          placeholder="Episode"
          className="bg-white/10 border border-white/20 rounded px-3 py-2 w-24"
        />
        <input
          value={season}
          onChange={(e) => setSeason(e.target.value)}
          placeholder="Season"
          className="bg-white/10 border border-white/20 rounded px-3 py-2 w-24"
        />
        <button
          onClick={testStream}
          disabled={loading}
          className="bg-red-600 hover:bg-red-500 px-4 py-2 rounded"
        >
          {loading ? "Loading..." : "Step 1: Test Stream API"}
        </button>
      </div>

      {/* Stream API result */}
      {result && (
        <div className="mb-4">
          <div className={`p-4 rounded border ${
            result.url
              ? "border-green-500/30 bg-green-500/5"
              : "border-red-500/30 bg-red-500/5"
          }`}>
            <p className="mb-2">
              {result.url
                ? "✅ Stream API returned a URL"
                : "❌ Stream API returned no URL"}
            </p>
            {result.url && (
              <p className="text-xs text-gray-400 break-all mb-3">
                URL: {result.url}
              </p>
            )}
            {result.source && (
              <p className="text-green-400 text-xs mb-3">
                Source: {result.source}
              </p>
            )}
            {result.error && (
              <p className="text-red-400 text-xs">Error: {result.error}</p>
            )}
            {result.url && (
              <button
                onClick={testProxy}
                className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm"
              >
                Step 2: Test Proxy URL (fetch M3U8)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Proxy result */}
      {proxyResult && (
        <div className="mb-4">
          <p className="text-yellow-400 mb-2">Proxy response:</p>
          <pre className={`p-4 rounded border text-xs overflow-auto max-h-96 whitespace-pre-wrap break-all ${
            proxyResult.startsWith("#EXTM3U")
              ? "border-green-500/30 bg-green-500/5 text-green-300"
              : "border-red-500/30 bg-red-500/5 text-red-300"
          }`}>
            {proxyResult.startsWith("#EXTM3U")
              ? "✅ VALID M3U8!\n\n" + proxyResult
              : "❌ NOT a valid M3U8!\n\n" + proxyResult}
          </pre>
        </div>
      )}

      {/* Full API response */}
      {result && (
        <div>
          <p className="text-gray-400 mb-2">Full API response:</p>
          <pre className="bg-white/5 border border-white/10 rounded p-4 text-xs overflow-auto max-h-64">
            {JSON.stringify(result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
