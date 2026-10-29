import { useRef, useState } from "react";

export function useProjectSession(options?: {
  initialRevision?: number;
}) {
  const [projectSessionId, setProjectSessionId] = useState<string | null>(null);
  const [activeProjectFilePath, setActiveProjectFilePath] = useState<string | null>(null);
  const [recentProjectId, setRecentProjectId] = useState<string | null>(null);
  const [sessionRevision, setSessionRevision] = useState<number>(options?.initialRevision ?? 1);

  const sessionRevisionRef = useRef<number>(sessionRevision);
  sessionRevisionRef.current = sessionRevision;

  function incrementRevision() {
    setSessionRevision((prev) => prev + 1);
  }

  function clearProjectSession() {
    setProjectSessionId(null);
    setActiveProjectFilePath(null);
    setRecentProjectId(null);
    setSessionRevision(options?.initialRevision ?? 1);
  }

  return {
    projectSessionId,
    setProjectSessionId,
    activeProjectFilePath,
    setActiveProjectFilePath,
    recentProjectId,
    setRecentProjectId,
    sessionRevision,
    setSessionRevision,
    sessionRevisionRef,
    incrementRevision,
    clearProjectSession
  };
}
