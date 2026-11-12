ALTER TABLE operations_video_edits ADD COLUMN narration bytea;
ALTER TABLE operations_video_edits ADD COLUMN is_final boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX operations_video_one_final ON operations_video_edits(tenant_id,user_id,task_id) WHERE is_final;
CREATE TABLE employee_diagnostic_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 department text NOT NULL, config_revision integer NOT NULL, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE employee_diagnostic_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_diagnostic_history FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_diagnostic_history_private ON employee_diagnostic_history
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
