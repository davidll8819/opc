CREATE TABLE operations_video_shots (
 id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 task_id text NOT NULL, input jsonb NOT NULL, model text NOT NULL,
 state text NOT NULL CHECK(state IN ('submitting','submitted','completed','failed','uncertain')),
 remote_id text, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,id)
);
ALTER TABLE operations_video_shots ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_video_shots FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_video_shots_private ON operations_video_shots
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
