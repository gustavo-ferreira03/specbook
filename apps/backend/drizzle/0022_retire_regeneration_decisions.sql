UPDATE jobs SET status = 'cancelled', pending_message = '', retry_at = NULL
WHERE id IN (SELECT job_id FROM inbox_items WHERE json_type(payload, '$.regenerationSpecs') = 'array')
  AND status IN ('queued', 'running', 'paused', 'blocked', 'stalled');
--> statement-breakpoint
UPDATE inbox_items
SET status = 'dismissed', payload = json_set(payload, '$.retiredByScope', json('true'))
WHERE json_type(payload, '$.regenerationSpecs') = 'array';
