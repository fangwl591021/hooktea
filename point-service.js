// A durable operation journal around the mother API. Never replay an uncertain
// POST. Reconcile by our exact transaction marker, not by a balance difference.
export function createPointService({ db, query, insert }) {
  if (!db) throw new Error('POINT_JOURNAL_UNAVAILABLE');
  const run = async (sql, ...values) => {
    const result = await db.prepare(sql).bind(...values).run();
    if (result?.success === false) throw new Error('POINT_JOURNAL_WRITE_FAILED');
    return Number(result?.meta?.changes || 0);
  };
  const first = (sql, ...values) => db.prepare(sql).bind(...values).first();
  const all = async (sql, ...values) => (await db.prepare(sql).bind(...values).all()).results || [];
  const get = id => first('SELECT * FROM point_operations WHERE operation_id = ?', id);
  const marker = id => `[HT:${id}]`;
  const publicResult = row => ({
    id: row?.operation_id, ok: row?.status === 'confirmed',
    pending: !!row && !['confirmed','rejected'].includes(row.status),
    status: row?.status || 'missing', amount: Number(row?.amount || 0),
    balance: row?.mother_balance_after == null ? null : Number(row.mother_balance_after),
    error: row?.error_code || '',
  });
  const requireIdentity = (lineUid, member) => {
    const ids = [member?.lineUserId, member?.linkedLineUid, member?.lineUid,
      /^U[0-9a-f]{32}$/i.test(member?.userId || '') ? member.userId : ''].filter(Boolean);
    if (!ids.length) throw new Error('POINT_MEMBER_REQUIRES_LINE_BINDING');
    if (ids.some(id => String(id) !== lineUid)) throw new Error('POINT_IDENTITY_CONFLICT');
  };
  // Check the current row in the DELETE itself. A stale read of a queued row
  // must never release a lock after another attempt starts its POST.
  const release = row => run(`DELETE FROM point_sync_locks
    WHERE line_user_id = ? AND operation_id = ?
    AND EXISTS (SELECT 1 FROM point_operations
      WHERE operation_id = ? AND status NOT IN ('sending','reconciling'))`,
    row.line_user_id, row.operation_id, row.operation_id);
  async function transition(row, status, error = '', balance = null, transactionId = null) {
    // Only the state actually observed by this caller may transition. In
    // particular, late preflight failures cannot downgrade another sender, and
    // neither terminal result can be changed by late responses.
    await run(`UPDATE point_operations SET status = ?, error_code = ?, mother_balance_after = ?,
      mother_transaction_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE operation_id = ? AND status = ? AND status NOT IN ('confirmed','rejected')`,
      status, error, balance, transactionId, row.operation_id, row.status);
    const current = await get(row.operation_id);
    if (current && !['sending','reconciling'].includes(current.status)) await release(current);
    return publicResult(current);
  }
  async function reconcile(row, shared) {
    if (!row || !shared?.ok || !['sending','reconciling'].includes(row.status)) return publicResult(row);
    const matches = (shared.list || []).filter(entry =>
      String(entry.event_content || '').endsWith(marker(row.operation_id)) &&
      Number(entry.get_point) === Number(row.amount));
    if (matches.length !== 1) return publicResult(row);
    const entry = matches[0];
    return transition(row, 'confirmed', '', Number(shared.balance), String(entry.id || ''));
  }
  async function snapshot(lineUid, pointUid, legacy) {
    if (!legacy || legacy.authority === 'mother' || (!Number(legacy.balance) && !(legacy.logs || []).length)) return;
    await run(`INSERT OR IGNORE INTO point_legacy_snapshots(point_uid,line_user_id,snapshot_json)
      VALUES(?,?,?)`, pointUid, lineUid, JSON.stringify(legacy));
  }
  async function read(lineUid, member, { readOnly = false } = {}) {
    requireIdentity(lineUid, member);
    const shared = await query(member).catch(() => ({ok:false, reason:'mother_unavailable'}));
    const lock = await first('SELECT operation_id FROM point_sync_locks WHERE line_user_id = ?', lineUid);
    if (lock && !readOnly) {
      const row = await get(lock.operation_id);
      if (row?.status === 'confirmed' || row?.status === 'rejected') await release(row);
      else if (row) await reconcile(row, shared);
    }
    const pending = await first(`SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS balance,
      COUNT(*) AS count FROM point_operations WHERE line_user_id = ?
      AND status NOT IN ('confirmed','rejected')`, lineUid);
    const review = await first(`SELECT COUNT(*) AS count FROM point_legacy_snapshots
      WHERE line_user_id = ? AND status = 'review'`, lineUid);
    const unsettled = await first('SELECT operation_id FROM point_sync_locks WHERE line_user_id = ?', lineUid);
    return {
      balance: shared.ok ? Math.max(0, Number(shared.balance || 0)) : 0,
      source: 'wetw', authority: 'mother', available: !!shared.ok && !unsettled,
      pendingBalance: Number(pending?.balance || 0), pendingCount: Number(pending?.count || 0),
      legacyReviewRequired: Number(review?.count || 0) > 0,
      shared, reconciliationRequired: !!unsettled,
    };
  }
  async function attempt(id, member) {
    let row = await get(id);
    if (!row) throw new Error('POINT_OPERATION_MISSING');
    requireIdentity(row.line_user_id, member);
    if (['confirmed','rejected'].includes(row.status)) return publicResult(row);
    const shared = await query(member).catch(() => ({ok:false,reason:'mother_unavailable'}));
    if (['sending','reconciling'].includes(row.status)) return reconcile(row, shared);
    if (!shared.ok) {
      const missing = Number(shared.status) === 404 && (shared.reason || shared.code) === 'user_not_found';
      // No POST has occurred: these queued intents can safely be retried later.
      return transition(row, missing ? 'pending_member' : 'pending_config', shared.reason || 'mother_unavailable');
    }
    await run('INSERT OR IGNORE INTO point_sync_locks(line_user_id,operation_id) VALUES(?,?)', row.line_user_id, id);
    let lock = await first('SELECT operation_id FROM point_sync_locks WHERE line_user_id = ?', row.line_user_id);
    if (lock?.operation_id !== id) {
      const other = lock ? await get(lock.operation_id) : null;
      if (other?.status === 'confirmed' || other?.status === 'rejected') await release(other);
      else if (other) await reconcile(other, shared);
      return {...publicResult(row), error:'ACCOUNT_OPERATION_PENDING'};
    }
    const changed = await run(`UPDATE point_operations SET status = 'sending', error_code = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE operation_id = ?
      AND status IN ('queued','pending_member','pending_config')
      AND EXISTS (SELECT 1 FROM point_sync_locks WHERE line_user_id = ? AND operation_id = ?)`,
      id, row.line_user_id, id);
    if (!changed) return publicResult(await get(id));
    row = await get(id);
    // Re-query after obtaining the per-account lock; earlier reads may be stale.
    const fresh = await query(member).catch(() => ({ok:false,reason:'mother_unavailable'}));
    if (!fresh.ok) return transition(row, 'pending_config', fresh.reason || 'mother_unavailable');
    if (row.amount < 0 && Number(fresh.balance) < -row.amount) return transition(row, 'rejected', 'INSUFFICIENT_POINTS');
    let result;
    try {
      result = await insert(member, Number(row.amount), `${row.reason} ${marker(id)}`);
    } catch (error) {
      // The server may have committed before the connection timed out.
      return transition(row, 'reconciling', 'MOTHER_RESULT_UNKNOWN');
    }
    if (result?.ok) {
      const value = result.balance;
      const balance = value == null || value === '' ? null : Number(value);
      return transition(row, 'confirmed', '', Number.isFinite(balance) ? balance : null, result.transactionId || null);
    }
    if (Number(result?.status) === 404 && result?.code === 'user_not_found') return transition(row, 'pending_member', 'user_not_found');
    // Only an explicit no-write business rejection is safe to release. Unknown
    // HTTP errors/5xx/malformed replies retain the account lock for reconciliation.
    if (result?.definitiveRejection) return transition(row, 'rejected', result.code || 'MOTHER_REJECTED');
    return transition(row, 'reconciling', result?.code || 'MOTHER_RESULT_UNKNOWN');
  }
  async function submit(input, member) {
    const {id,lineUid,memberUid,kind,amount,reason} = input;
    if (!id || !/^U[0-9a-f]{32}$/i.test(lineUid) || !Number.isSafeInteger(amount) || !amount) throw new Error('INVALID_POINT_OPERATION');
    requireIdentity(lineUid, member);
    const inserted = await run(`INSERT OR IGNORE INTO point_operations
      (operation_id,line_user_id,member_uid,kind,amount,reason,status,metadata_json)
      VALUES(?,?,?,?,?,?,'queued',?)`, id,lineUid,memberUid,kind,amount,reason,JSON.stringify(input.metadata || {}));
    const row = await get(id);
    if (row.line_user_id !== lineUid || Number(row.amount) !== amount || row.kind !== kind) throw new Error('POINT_OPERATION_CONFLICT');
    // Callers retrying a business action never cause another POST. Pending work
    // is resumed separately, after authenticated account lookup succeeds.
    return inserted ? attempt(id,member) : {...publicResult(row), duplicate:true};
  }
  async function resume(lineUid, member) {
    requireIdentity(lineUid, member);
    const candidates = await all(`SELECT operation_id FROM point_operations
      WHERE line_user_id = ? AND amount > 0 AND status IN ('queued','pending_member','pending_config','sending','reconciling')
      ORDER BY created_at,operation_id LIMIT 5`, lineUid);
    for (const row of candidates) {
      const result = await attempt(row.operation_id, member);
      if (result.status !== 'confirmed' && result.status !== 'rejected') break;
    }
  }
  return {submit,attempt,resume,read,snapshot,get,publicResult};
}
