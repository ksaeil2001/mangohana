import { fireEvent, screen, within } from "@testing-library/react";

/** Open the same workspace navigation action a user chooses before editing. */
export async function openWorkspacePanel(name: "페이지" | "수정" | "진행" | "문맥") {
  const navigation = await screen.findByRole("navigation", { name: "작업 영역" });
  const button = within(navigation).getByRole("button", { name });
  if (button.getAttribute("aria-expanded") !== "true") fireEvent.click(button);
  const region = name === "페이지"
    ? await screen.findByRole("complementary", { name: "페이지 목록" })
    : name === "수정"
      ? await screen.findByRole("complementary", { name: "오른쪽 작업 패널" })
      : name === "진행"
        ? await screen.findByRole("region", { name: "하단 대사 패널" })
        : await screen.findByRole("region", { name: "등장인물과 용어 문맥" });
  return region;
}

export function openTxtStartActions() {
  const summary = screen.getByText("다른 시작 방법", { selector: "summary" });
  if (!summary.closest("details")!.open) fireEvent.click(summary);
}

export async function findWorkStatus(text: string | RegExp) {
  const status = await screen.findByRole("status", { name: "작업 상태" });
  return within(status).findByText(text);
}

export async function selectWorkspaceEditingTool(name: "원문" | "번역" | "글자 배치") {
  const inspector = await openWorkspacePanel("수정");
  fireEvent.click(within(within(inspector).getByRole("group", { name: "수정 도구" })).getByRole("button", { name }));
}
