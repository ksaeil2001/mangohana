import { useReducer, useRef, useState } from "react";
import {
  initialProjectSetupState,
  projectSetupReducer,
  type ProjectSetupAction,
  type ProjectSetupState
} from "./projectSetupState.js";
import type { PreparedPageImage, TranslationMode } from "../shared/projectTypes.js";

export function useProjectSetup() {
  const [projectSetup, dispatchProjectSetup] = useReducer(
    projectSetupReducer,
    initialProjectSetupState
  );
  const [projectSetupStoragePath, setProjectSetupStoragePath] = useState<string | null>(null);
  const projectSetupOperationTokenRef = useRef(0);

  function resetProjectSetup() {
    projectSetupOperationTokenRef.current += 1;
    dispatchProjectSetup({ type: "reset" });
    setProjectSetupStoragePath(null);
  }

  function startPreparingProjectSetup() {
    const operationToken = ++projectSetupOperationTokenRef.current;
    dispatchProjectSetup({
      type: "preparation-changed",
      isPreparing: true
    });
    return operationToken;
  }

  function finishPreparingProjectSetup(operationToken: number) {
    if (operationToken === projectSetupOperationTokenRef.current) {
      dispatchProjectSetup({
        type: "preparation-changed",
        isPreparing: false
      });
    }
  }

  function setProjectSetupMode(mode: TranslationMode) {
    dispatchProjectSetup({
      type: "mode-changed",
      mode
    });
  }

  return {
    projectSetup,
    dispatchProjectSetup,
    projectSetupStoragePath,
    setProjectSetupStoragePath,
    projectSetupOperationTokenRef,
    resetProjectSetup,
    startPreparingProjectSetup,
    finishPreparingProjectSetup,
    setProjectSetupMode
  };
}
