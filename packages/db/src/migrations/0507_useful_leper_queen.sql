ALTER TABLE "case_events" DROP CONSTRAINT IF EXISTS "case_events_kind_check";--> statement-breakpoint
ALTER TABLE "case_handoffs" DROP CONSTRAINT IF EXISTS "case_handoffs_state_check";--> statement-breakpoint
ALTER TABLE "case_handoffs" DROP CONSTRAINT IF EXISTS "case_handoffs_destination_state_check";--> statement-breakpoint
DROP INDEX IF EXISTS "case_handoffs_pending_case_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "case_handoffs_pending_issue_uq";--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD COLUMN IF NOT EXISTS "offer_contract" jsonb;--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD COLUMN IF NOT EXISTS "recipient_decision" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "case_handoffs_pending_case_uq" ON "case_handoffs" USING btree ("case_id") WHERE "case_handoffs"."state" in ('offered', 'awaiting_release', 'pending_dispatch', 'awaiting_completion');--> statement-breakpoint
CREATE UNIQUE INDEX "case_handoffs_pending_issue_uq" ON "case_handoffs" USING btree ("issue_id") WHERE "case_handoffs"."state" in ('offered', 'awaiting_release', 'pending_dispatch', 'awaiting_completion');--> statement-breakpoint
ALTER TABLE "case_events" ADD CONSTRAINT "case_events_kind_check" CHECK ("case_events"."kind" in (
        'created',
        'updated',
        'fields_changed',
        'status_changed',
        'issue_linked',
        'issue_unlinked',
        'document_revised',
        'child_linked',
        'attachment_added',
        'label_added',
        'label_removed',
        'handoff_requested',
        'handoff_decision_recorded',
        'handoff_applied',
        'handoff_delivered',
        'handoff_completed',
        'handoff_cancelled'
      ));--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_state_check" CHECK ("case_handoffs"."state" in ('offered', 'awaiting_release', 'pending_dispatch', 'delivered', 'awaiting_completion', 'completed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD CONSTRAINT "case_handoffs_destination_state_check" CHECK (("case_handoffs"."destination_kind" = 'agent' and "case_handoffs"."state" in ('offered', 'awaiting_release', 'pending_dispatch', 'delivered', 'cancelled')) or ("case_handoffs"."destination_kind" = 'done' and "case_handoffs"."state" in ('awaiting_completion', 'completed', 'cancelled')));