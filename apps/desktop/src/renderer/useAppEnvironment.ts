import { useRef, useState } from "react";
import {
  createInitialEnvironmentSnapshot,
  type EnvironmentPreparationSnapshot
} from "../shared/environmentPreparation.js";

export function useAppEnvironment() {
  const [environmentSnapshot, setEnvironmentSnapshot] = useState<EnvironmentPreparationSnapshot | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [environmentError, setEnvironmentError] = useState<string | undefined>(undefined);
  const environmentRequestIdRef = useRef(0);

  async function refreshEnvironmentPreparation() {
    const requestId = ++environmentRequestIdRef.current;
    setEnvironmentLoading(true);
    setEnvironmentError(undefined);
    try {
      const snapshot = window.projectApi?.getEnvironmentSnapshot
        ? await window.projectApi.getEnvironmentSnapshot()
        : createInitialEnvironmentSnapshot(
            "Electron Main에서 저장 위치를 확인합니다.",
            "브라우저 미리보기"
          );
      if (requestId !== environmentRequestIdRef.current) return;
      setEnvironmentSnapshot(snapshot);
      if (!window.projectApi?.getEnvironmentSnapshot) {
        setEnvironmentError("Electron Main이 연결되지 않아 브라우저 미리보기 상태를 표시합니다.");
      }
    } catch (error) {
      if (requestId !== environmentRequestIdRef.current) return;
      setEnvironmentError(error instanceof Error ? error.message : "환경 상태를 확인하지 못했습니다.");
    } finally {
      if (requestId === environmentRequestIdRef.current) setEnvironmentLoading(false);
    }
  }

  async function chooseEnvironmentResourceRoot() {
    if (!window.projectApi?.chooseEnvironmentResourceRoot) {
      setEnvironmentError("Electron Main이 연결되지 않아 저장 위치를 변경할 수 없습니다.");
      return;
    }
    const requestId = ++environmentRequestIdRef.current;
    setEnvironmentLoading(true);
    setEnvironmentError(undefined);
    try {
      const snapshot = await window.projectApi.chooseEnvironmentResourceRoot();
      if (requestId === environmentRequestIdRef.current && snapshot) setEnvironmentSnapshot(snapshot);
    } catch (error) {
      if (requestId === environmentRequestIdRef.current) {
        setEnvironmentError(error instanceof Error ? error.message : "리소스 저장 위치를 변경하지 못했습니다.");
      }
    } finally {
      if (requestId === environmentRequestIdRef.current) setEnvironmentLoading(false);
    }
  }

  async function installProductionOcr() {
    if (!window.projectApi?.installProductionOcr) {
      setEnvironmentError("Electron Main이 연결되지 않아 Production OCR을 설치할 수 없습니다.");
      return;
    }
    const requestId = ++environmentRequestIdRef.current;
    setEnvironmentLoading(true);
    setEnvironmentError(undefined);
    try {
      const snapshot = await window.projectApi.installProductionOcr();
      if (requestId === environmentRequestIdRef.current) setEnvironmentSnapshot(snapshot);
    } catch (error) {
      if (requestId === environmentRequestIdRef.current) {
        setEnvironmentError(error instanceof Error ? error.message : "Production OCR 설치 또는 복구에 실패했습니다.");
        if (window.projectApi.getEnvironmentSnapshot) {
          const snapshot = await window.projectApi.getEnvironmentSnapshot().catch(() => null);
          if (requestId === environmentRequestIdRef.current && snapshot) setEnvironmentSnapshot(snapshot);
        }
      }
    } finally {
      if (requestId === environmentRequestIdRef.current) setEnvironmentLoading(false);
    }
  }

  function resetEnvironmentState() {
    environmentRequestIdRef.current += 1;
    setEnvironmentLoading(false);
    if (!window.projectApi?.getEnvironmentSnapshot) {
      setEnvironmentSnapshot(null);
    }
  }

  return {
    environmentSnapshot,
    setEnvironmentSnapshot,
    environmentLoading,
    setEnvironmentLoading,
    environmentError,
    setEnvironmentError,
    refreshEnvironmentPreparation,
    chooseEnvironmentResourceRoot,
    installProductionOcr,
    resetEnvironmentState
  };
}
