export type ProprioSemanticActionId =
  | "search_api"
  | "call_api"
  | "set_task_title"
  | "send_chat_message"
  | "set_task_monitor"
  | "get_task_context"
  | "get_task_history"
  | "list_documents"
  | "read_document"
  | "list_document_revisions"
  | "report_progress"
  | "answer_status_question"
  | "write_document"
  | "request_human_input"
  | "register_deliverable"
  | "finish_task"
  | "block_task"
  | "request_review"
  | "list_agents"
  | "hire_agent"
  | "get_agent"
  | "search_tasks"
  | "list_approvals"
  | "get_approval"
  | "get_approval_context"
  | "get_workspace_runtime"
  | "control_workspace_service"
  | "reassign_task"
  | "set_dependencies"
  | "create_skill"
  | "update_skill"
  | "get_workspace"
  | "list_workspaces"
  | "select_workspace"
  | "prepare_repository"
  | "create_project"
  | "list_project_repositories"
  | "list_projects"
  | "list_responsibilities"
  | "get_responsibility"
  | "find_responsibilities_for"
  | "create_area"
  | "update_area"
  | "delete_area"
  | "create_responsibility"
  | "update_responsibility"
  | "delete_responsibility"
  | "file_under_responsibility"
  | "remove_from_responsibility"
  | "list_routines"
  | "update_routine"
  | "update_skill_details"
  | "create_task"
  | "handoff_case"
  | "read_case"
  | "update_case"
  | "create_case"
  | "list_workflows"
  | "read_workflow"
  | "create_workflow"
  | "update_workflow"
  | "request_approval"
  | "decide_approval"
  | "comment_on_approval"
  | "schedule_wake";

export type ProprioSemanticActionPlacement = "always" | "optional";
export type ProprioSemanticActionMode =
  "standard" | "ask" | "planning" | "skill_test";
export type ProprioSemanticActionEffect = "read" | "write" | "governance";

export type ProprioJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProprioJsonValue[]
  | { readonly [key: string]: ProprioJsonValue };

/** The JSON Schema subset used by the v1 semantic action catalog. */
export interface ProprioJsonSchema {
  readonly type?: string | readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, ProprioJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | ProprioJsonSchema;
  readonly items?: ProprioJsonSchema;
  readonly enum?: readonly ProprioJsonValue[];
  readonly const?: ProprioJsonValue;
  readonly oneOf?: readonly ProprioJsonSchema[];
  readonly anyOf?: readonly ProprioJsonSchema[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly pattern?: string;
  readonly format?: string;
  readonly default?: ProprioJsonValue;
}

/**
 * A transport-neutral declaration. Catalog membership never grants discovery
 * or invocation authority; a run-scoped authorization layer must do that.
 */
export interface ProprioSemanticActionDescriptor {
  readonly schema: "proprio.semantic-action.v1";
  readonly operationId: ProprioSemanticActionId;
  readonly version: 1;
  readonly title: string;
  readonly description: string;
  readonly placement: ProprioSemanticActionPlacement;
  readonly effect: ProprioSemanticActionEffect;
  readonly requiredClaims: readonly string[];
  readonly allowedModes: readonly ProprioSemanticActionMode[];
  readonly allowedRoles?: readonly string[];
  readonly inputSchema: ProprioJsonSchema;
  readonly outputSchema: ProprioJsonSchema;
}
