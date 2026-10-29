export type EntryScreen =
  | "home"
  | "projects"
  | "files"
  | "ai"
  | "tools"
  | "dictionary"
  | "settings"
  | "setup"
  | "preparation"
  | "workspace";

export type PreparationReturnScreen = EntryScreen;

export type EntryFlowState = {
  screen: EntryScreen;
  preparationReturnScreen?: PreparationReturnScreen;
};

export type EntryFlowAction =
  | { type: "navigate"; screen: EntryScreen }
  | { type: "new-project" }
  | { type: "setup-canceled" }
  | { type: "create-canceled" }
  | { type: "open-preparation"; returnTo: PreparationReturnScreen }
  | { type: "preparation-closed" }
  | { type: "project-installed"; hasContent: boolean };

export const initialEntryFlowState: EntryFlowState = { screen: "home" };

export function entryFlowReducer(state: EntryFlowState, action: EntryFlowAction): EntryFlowState {
  switch (action.type) {
    case "navigate":
      return { ...state, screen: action.screen };
    case "new-project":
      return { screen: "setup" };
    case "setup-canceled":
      return { screen: "home" };
    case "create-canceled":
      return state;
    case "open-preparation":
      return {
        screen: "preparation",
        preparationReturnScreen: action.returnTo
      };
    case "preparation-closed":
      return {
        screen: state.preparationReturnScreen ?? "home"
      };
    case "project-installed":
      // An empty project is still a project: keep the user in the shared
      // Workspace shell so the canvas can offer image import in context.
      return { screen: "workspace" };
  }
}
