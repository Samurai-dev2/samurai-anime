
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import TestStreamPage from "./pages/TestStreamPage";
import { ClerkProvider, useAuth } from "@clerk/clerk-react";
import Navbar from "./components/Navbar";
import HomePage from "./pages/HomePage";
import AnimeDetailPage from "./pages/AnimeDetailPage";
import WatchPage from "./pages/WatchPage";
import LibraryPage from "./pages/LibraryPage";
import BrowsePage from "./pages/BrowsePage";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string;

function LoadingScreen() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-black">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-2 border-zinc-800 border-t-red-500 rounded-full animate-spin" />
        <p className="text-zinc-600 text-sm">Loading...</p>
      </div>
    </div>
  );
}

function NotFoundPage() {
  return (
    <div className="flex items-center justify-center min-h-screen flex-col gap-4">
      <div className="text-8xl font-black text-red-600 opacity-30">404</div>
      <p className="text-gray-400 text-xl">Page not found</p>
      <a href="/" className="px-5 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-xl transition-colors">
        Go Home
      </a>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  if (!isLoaded) return <LoadingScreen />;
  if (!isSignedIn) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

// ─── FIXED AuthRoute ───────────────────────────────────────────────────────
// Key change: signup page is EXCLUDED from the redirect
// even if the user becomes signed in during the avatar step
// we don't want to kick them away mid-flow
function AuthRoute({ children }: { children: React.ReactNode }) {
  const { isSignedIn, isLoaded } = useAuth();
  const location = useLocation();

  if (!isLoaded) return <LoadingScreen />;

  // If signed in AND we're on /login → go home
  // If signed in AND we're on /signup → do NOT redirect
  // because they might be on the avatar step of signup
  if (isSignedIn && location.pathname === '/login') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function NavbarWrapper() {
  const location = useLocation();
  const authPages = ["/login", "/signup"];
  if (authPages.includes(location.pathname)) return null;
  return <Navbar />;
}

function AppContent() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-black text-white" style={{ fontFamily: "Inter, sans-serif" }}>
        <NavbarWrapper />
        <Routes>
          {/* ── Public ── */}
          <Route path="/" element={<HomePage />} />
          <Route path="/anime/:malId" element={<AnimeDetailPage />} />
          <Route path="/browse" element={<BrowsePage />} />

          {/* ── Auth pages ── */}
          <Route
            path="/login"
            element={
              <AuthRoute>
                <LoginPage />
              </AuthRoute>
            }
          />
          {/* Signup has NO AuthRoute wrapper now */}
          {/* so being signed in wont kick you out mid avatar step */}
          <Route path="/signup" element={<SignupPage />} />

          {/* ── Protected ── */}
          <Route
            path="/watch/:malId"
            element={
              <ProtectedRoute>
                <WatchPage />
              </ProtectedRoute>
            }
          />
          <Route path="/test-stream" element={<TestStreamPage />} />
          <Route
            path="/library"
            element={
              <ProtectedRoute>
                <LibraryPage />
              </ProtectedRoute>
            }
          />

          {/* ── 404 ── */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}

export default function App() {
  if (!publishableKey) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-black flex-col gap-4 px-4">
        <div className="text-6xl">⚠️</div>
        <h1 className="text-white text-2xl font-bold">Missing Clerk Key</h1>
        <p className="text-zinc-400 text-sm text-center max-w-md">
          Create a <span className="text-red-400 font-mono">.env</span> file and add:
        </p>
        <code className="bg-zinc-900 border border-zinc-700 text-red-400 px-4 py-3 rounded-xl text-sm">
          VITE_CLERK_PUBLISHABLE_KEY=pk_test_your_key_here
        </code>
      </div>
    );
  }

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <AppContent />
    </ClerkProvider>
  );
}
