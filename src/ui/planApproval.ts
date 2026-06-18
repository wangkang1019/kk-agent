import type {
  PlanApprovalChoice,
  PlanApprovalResponse,
} from "../permissions/permissions.js";

export interface PlanApprovalOption {
  choice: PlanApprovalChoice;
  label: string;
  description: string;
}

export const PLAN_APPROVAL_OPTIONS: PlanApprovalOption[] = [
  {
    choice: "allow_clear_context",
    label: "Yes, auto-accept edits (clear context)",
    description: "auto-approve writes, fresh execution context",
  },
  {
    choice: "allow_keep_context",
    label: "Yes, auto-accept edits (keep context)",
    description: "auto-approve writes, keep conversation context",
  },
  {
    choice: "allow_manual_edits",
    label: "Yes, manually approve edits",
    description: "ask before each write or state-changing command",
  },
  {
    choice: "keep_planning",
    label: "No, keep planning",
    description: "send feedback and stay in plan mode",
  },
];

export function movePlanApprovalSelection(
  currentIndex: number,
  direction: "up" | "down",
): number {
  const delta = direction === "up" ? -1 : 1;
  return (currentIndex + delta + PLAN_APPROVAL_OPTIONS.length) %
    PLAN_APPROVAL_OPTIONS.length;
}

export function requiresPlanFeedback(choice: PlanApprovalChoice): boolean {
  return choice === "keep_planning";
}

export function createPlanApprovalResponse(params: {
  choice: PlanApprovalChoice;
  planContent: string;
  feedback?: string;
}): PlanApprovalResponse {
  return {
    type: "plan_approval",
    choice: params.choice,
    planContent: params.planContent,
    ...(params.feedback && { feedback: params.feedback }),
  };
}
