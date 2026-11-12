CREATE TABLE operations_video_edits (
 id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 task_id text NOT NULL CHECK(task_id ~ '^[a-f0-9]{24}$'), fingerprint text NOT NULL,
 spec jsonb NOT NULL, music bytea,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed')),
 phase text NOT NULL DEFAULT '等待处理', error text,
 result jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,id)
);
CREATE INDEX operations_video_edits_task ON operations_video_edits(tenant_id,user_id,task_id,created_at DESC);
ALTER TABLE operations_video_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_video_edits FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_video_edits_private ON operations_video_edits
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
