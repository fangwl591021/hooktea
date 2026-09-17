export async function reconcileTrackingIncidents(env) {
  // Aging is an alert condition, NOT proof that a business operation failed or succeeded.
  const rows=(await env.DB.prepare(`SELECT l.lease_id FROM crm_request_leases l
    LEFT JOIN crm_request_reviews r ON r.lease_id=l.lease_id
    WHERE l.state IN ('active','uncertain') AND l.started_at<datetime('now','-15 minutes')
    AND r.lease_id IS NULL LIMIT 50`).all()).results||[];
  // Local review only: never promote missing completion evidence to an owner alarm.
  for(const {lease_id:id} of rows)await env.DB.prepare(`INSERT OR IGNORE INTO crm_request_reviews(lease_id,status,evidence)
      VALUES(?,'known_unresolved','unconfirmed_finish; no_replay_no_balance_change')`).bind(id).run();
  const finished=(await env.DB.prepare(`SELECT r.lease_id FROM crm_request_reviews r
    JOIN crm_request_leases l ON l.lease_id=r.lease_id WHERE r.status='known_unresolved' AND l.state='done' LIMIT 50`).all()).results||[];
  for(const {lease_id:id} of finished)await env.DB.prepare("UPDATE crm_request_reviews SET status='resolved',evidence='request_finish_recorded; business_result_not_replayed',reviewed_at=CURRENT_TIMESTAMP WHERE lease_id=?").bind(id).run();
}

export async function trackingStatus(env) {
  const counts=await env.DB.prepare(`SELECT
    SUM(CASE WHEN l.state='active' AND l.started_at>=datetime('now','-15 minutes') THEN 1 ELSE 0 END) inProgress,
    SUM(CASE WHEN l.state IN ('active','uncertain') AND l.started_at<datetime('now','-15 minutes') AND r.lease_id IS NULL THEN 1 ELSE 0 END) newUnresolved,
    SUM(CASE WHEN r.status='known_unresolved' THEN 1 ELSE 0 END) knownUnresolved
    FROM crm_request_leases l LEFT JOIN crm_request_reviews r ON r.lease_id=l.lease_id`).first();
  const rows=(await env.DB.prepare(`SELECT l.lease_id,l.state,l.started_at,r.status review_status,r.evidence,
    m.route,m.method,m.operation,m.phase,m.response_status FROM crm_request_leases l
    LEFT JOIN crm_request_reviews r ON r.lease_id=l.lease_id LEFT JOIN crm_request_metadata m ON m.lease_id=l.lease_id
    WHERE l.state IN ('active','uncertain') AND l.started_at<datetime('now','-15 minutes') ORDER BY l.started_at LIMIT 100`).all()).results||[];
  return {counts,rows};
}
