import Dexie from 'dexie'

export const db = new Dexie('KaushalSetuRpl')
db.version(1).stores({
  workerDrafts: '&id, updatedAt',
  intakeQueue: '&intakeId, status, createdAt',
  assessments: '&clientRecordId, status, workerId, assessmentMode, createdAt',
})

export async function saveWorkerDraft(draft) {
  await db.workerDrafts.put({ ...draft, updatedAt: new Date().toISOString() })
}

export async function queueWorkerIntake(payload) {
  await db.intakeQueue.put({
    intakeId: payload.intake_id,
    payload,
    status: 'pending',
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
}

export async function queueAssessment(payload) {
  const clientRecordId = payload.client_record_id
  await db.assessments.put({
    clientRecordId,
    payload,
    workerId: payload.worker_id,
    assessmentMode: payload.assessment_mode,
    status: 'pending',
    createdAt: new Date().toISOString(),
    attempts: 0,
  })
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.error) throw new Error(data.detail?.message || data.error || `Server returned ${response.status}`)
  return data
}

export async function syncPendingRecords(apiBase) {
  if (!navigator.onLine) return { intakesSynced: 0, assessmentsSynced: 0, errors: [] }
  const errors = []
  let intakesSynced = 0
  let assessmentsSynced = 0

  const pendingIntakes = await db.intakeQueue.where('status').equals('pending').sortBy('createdAt')
  for (const item of pendingIntakes) {
    try {
      const serverResponse = await postJson(`${apiBase}/workers/intake`, item.payload)
      await db.intakeQueue.update(item.intakeId, {
        status: 'synced', serverResponse, syncedAt: new Date().toISOString(),
      })
      intakesSynced += 1
    } catch (error) {
      await db.intakeQueue.update(item.intakeId, { attempts: (item.attempts || 0) + 1, lastError: error.message })
      errors.push(`Intake ${item.intakeId}: ${error.message}`)
      break
    }
  }

  const pendingAssessments = await db.assessments.where('status').equals('pending').sortBy('createdAt')
  for (const item of pendingAssessments) {
    try {
      const serverResponse = await postJson(`${apiBase}/assessment/sync`, item.payload)
      await db.assessments.update(item.clientRecordId, {
        status: 'synced', serverResponse, syncedAt: new Date().toISOString(),
      })
      assessmentsSynced += 1
    } catch (error) {
      await db.assessments.update(item.clientRecordId, { attempts: (item.attempts || 0) + 1, lastError: error.message })
      errors.push(`Assessment ${item.clientRecordId}: ${error.message}`)
      break
    }
  }
  return { intakesSynced, assessmentsSynced, errors }
}

export async function getPendingQueueCounts() {
  const [intakes, assessments] = await Promise.all([
    db.intakeQueue.where('status').equals('pending').count(),
    db.assessments.where('status').equals('pending').count(),
  ])
  return { intakes, assessments }
}
