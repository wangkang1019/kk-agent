import {
  isPlanApprovalResponse,
  type PlanApprovalChoice,
  type PlanApprovalResponse,
  type PermissionResponse,
} from "../permissions/permissions.js";
import {
  buildAllowRulesFromPrompts,
  buildFullPlanModeText,
  ensurePlansDirectory,
  getPlanFilePath,
  readPlan,
  writePlan,
  type AllowedPrompt,
} from "../context/planMode.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const AUTO_ACCEPT_EDIT_RULES = ["Write", "Edit"];

function getPlanParams(context: ToolContext): {
  homeDir?: string;
  sessionId?: string;
} {
  return {
    ...(context.planHomeDir && { homeDir: context.planHomeDir }),
    ...(context.planSessionId && { sessionId: context.planSessionId }),
  };
}

function isAllowedPrompt(value: unknown): value is AllowedPrompt {
  return (
    typeof value === "object" &&
    value !== null &&
    "tool" in value &&
    "prompt" in value &&
    typeof value.tool === "string" &&
    typeof value.prompt === "string"
  );
}

function getPlanApproval(
  response: PermissionResponse | undefined,
): PlanApprovalResponse {
  if (isPlanApprovalResponse(response)) {
    return response;
  }

  return {
    type: "plan_approval",
    choice: "allow_keep_context",
    planContent: "",
  };
}

function shouldAutoAcceptEdits(choice: PlanApprovalChoice): boolean {
  return choice === "allow_clear_context" || choice === "allow_keep_context";
}

export const enterPlanModeTool: Tool = {
  name: "EnterPlanMode",
  description:
    "Enter plan mode before complex changes. In plan mode, explore with read-only tools and write an implementation plan before editing code.",
  inputSchema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description: "Why planning is useful before acting.",
      },
    },
    required: ["reason"],
  },
  async call(_input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.getPermissionMode?.() === "plan") {
      return { content: "Already in plan mode.", isError: true };
    }

    await ensurePlansDirectory(context.planHomeDir);
    const planPath = context.planFilePath ?? getPlanFilePath(getPlanParams(context));
    context.setPermissionMode?.("plan");

    return {
      content: buildFullPlanModeText(planPath),
    };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};

export const exitPlanModeTool: Tool = {
  name: "ExitPlanMode",
  description:
    "Exit plan mode after writing a plan. Use this when the plan is ready for user approval and implementation.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Short summary of the implementation plan.",
      },
      plan: {
        type: "string",
        description: "Optional final plan content to write before exiting.",
      },
      allowedPrompts: {
        type: "array",
        description:
          "Commands or tools that should be allowed during implementation after approval.",
      },
    },
    required: ["summary"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (context.getPermissionMode?.() !== "plan") {
      return { content: "Not currently in plan mode.", isError: true };
    }

    const planParams = getPlanParams(context);
    const planPath = context.planFilePath ?? getPlanFilePath(planParams);

    const approval = getPlanApproval(context.permissionResponse);
    const explicitPlan =
      typeof input.plan === "string" ? input.plan : approval.planContent;

    if (explicitPlan) {
      await writePlan({
        ...planParams,
        content: explicitPlan,
      });
    } else {
      await ensurePlansDirectory(context.planHomeDir);
    }

    const allowedPrompts = Array.isArray(input.allowedPrompts)
      ? input.allowedPrompts.filter(isAllowedPrompt)
      : [];
    const allowRules = buildAllowRulesFromPrompts(allowedPrompts);

    if (approval.choice === "keep_planning") {
      return {
        content: [
          "User rejected the plan. Stay in plan mode and revise the plan.",
          "",
          `Feedback: ${approval.feedback ?? "(No feedback provided)"}`,
          "",
          `Plan file: ${planPath}`,
        ].join("\n"),
      };
    }

    const rulesToAdd = shouldAutoAcceptEdits(approval.choice)
      ? [...allowRules, ...AUTO_ACCEPT_EDIT_RULES]
      : allowRules;

    if (rulesToAdd.length > 0) {
      context.addSessionAllowRules?.(rulesToAdd);
    }

    context.setPermissionMode?.("default");

    const planContent = await readPlan(planParams);

    return {
      content: [
        "Plan approved by user. Full tool access restored.",
        "",
        "IMPORTANT: Start implementing the approved plan immediately.",
        "Do not summarize the plan again or ask for another confirmation.",
        "",
        `Plan file: ${planPath}`,
        "",
        planContent ?? "(No plan content found)",
      ].join("\n"),
    };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};
