ALTER TABLE workspace_files ADD COLUMN deleted_at timestamptz;
CREATE INDEX workspace_files_recycle ON workspace_files(tenant_id,user_id,deleted_at);
