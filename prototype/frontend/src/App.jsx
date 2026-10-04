import { useEffect, useMemo, useState } from 'react'
import VoiceInput from './components/VoiceInput'
import CameraWatermark from './components/CameraWatermark'
import { db, getPendingQueueCounts, queueAssessment, queueWorkerIntake, saveWorkerDraft, syncPendingRecords } from './db/indexedDb'
import './App.css'

const API_BASE = 'http://127.0.0.1:8000'
const DRAFT_KEY = 'kaushalsetu-assessment-draft-v1'
const REFERENCE_KEY = 'kaushalsetu-assessment-reference-v1'
const ROLE_KEY = 'kaushalsetu-demo-role-v1'
const caseDraftKey = (workerId, mode) => `${DRAFT_KEY}:${workerId}:${mode}`
function Innov8Mark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 40 36" role="presentation"><path d="M4 18C9 8 14 8 20 18C26 28 31 28 36 18C31 8 26 8 20 18C14 28 9 28 4 18" /><path className="brand-spark" d="m21 11-5 8h4l-1 6 6-9h-4l1-5Z" /></svg></span>
}
const getExperienceYears = (statement = '') => {
  const match = String(statement).match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:years?|yrs?)\b/i)
  if (!match) return null
  const value = match[1].toLowerCase()
  return /^\d+$/.test(value) ? Number(value) : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(value) + 1
}
const createId = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(16).slice(2)}`

function readLocalJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}')
  } catch {
    return {}
  }
}

function WorkerIntakeWorkspace({ declarationText, setDeclarationText, intakeLanguage, setIntakeLanguage, photoEvidence, setPhotoEvidence, workerName, setWorkerName, matching, onSubmit, draftSaved, intakeStatus, queueCount, declarationResult, onStatementChanged }) {
  return (
    <section className="worker-intake-page" id="worker-intake">
      <div className="worker-welcome-card">
        <div className="eyebrow">WORKER SELF-SERVICE <span>•</span> DEMO</div>
        <h2>Tell us about the work you already know</h2>
        <p>Use your own words. Type or speak in a language you are comfortable with. Your draft is stored on this device and can sync when it reconnects.</p>
        <span className="worker-offline-tag">◉ Works offline after first load</span>
      </div>

      <form className="worker-intake-form" onSubmit={onSubmit}>
        <div className="panel-heading"><div><div className="eyebrow">YOUR EXPERIENCE</div><h2>Start with your story</h2></div><span className="item-count">NO SCORE FROM AI</span></div>
        <label className="worker-name-input">Your name (optional)<input value={workerName} onChange={(event) => setWorkerName(event.target.value)} placeholder="Enter your name" autoComplete="name" /></label>
        <label className="worker-language-field">Choose your language<select value={intakeLanguage} onChange={(event) => setIntakeLanguage(event.target.value)}><option value="hi-IN">हिन्दी · Hindi</option><option value="en-IN">English (India)</option><option value="kn-IN">ಕನ್ನಡ · Kannada</option><option value="ta-IN">தமிழ் · Tamil</option><option value="te-IN">తెలుగు · Telugu</option><option value="bn-IN">বাংলা · Bengali</option><option value="mr-IN">मराठी · Marathi</option></select></label>
        <label className="worker-statement-label" htmlFor="worker-portal-statement">What electrical work have you done?</label>
        <textarea id="worker-portal-statement" className="worker-statement-input" value={declarationText} onChange={(event) => { setDeclarationText(event.target.value); onStatementChanged() }} placeholder="For example, tell us about wiring, fitting switches, repairing fans, or other work you have done. You can describe it in your own language." rows="5" required />
        <VoiceInput language={intakeLanguage} onTranscriptChange={(transcript) => { setDeclarationText((current) => current ? `${current.trim()} ${transcript}` : transcript); onStatementChanged() }} />
        <CameraWatermark capturedEvidence={photoEvidence} onCapture={(evidence) => { setPhotoEvidence(evidence); onStatementChanged() }} />
        <div className="worker-intake-actions"><button className="primary-button" type="submit" disabled={matching || !declarationText.trim()}>{matching ? 'Saving your statement…' : 'Save and see suggested skill areas'} <span>→</span></button><small>{draftSaved ? '✓ Saved on this device' : 'Your draft is being saved…'}</small></div>
        {intakeStatus && <div className="intake-status" role="status">{intakeStatus}</div>}
        {queueCount > 0 && <div className="queue-note" role="status">{queueCount} item(s) waiting to sync when connected.</div>}
      </form>

      {declarationResult && <section className="worker-results-card" aria-live="polite">
        <div className="eyebrow">YOUR STATEMENT SUMMARY</div><h2>Suggested skill areas</h2>
        {(declarationResult.extraction.experience_years ?? getExperienceYears(declarationText)) != null && <p className="experience-found">Experience mentioned: <strong>{declarationResult.extraction.experience_years ?? getExperienceYears(declarationText)} years</strong></p>}
        {declarationResult.matchingData?.preliminary_matches?.length ? <div className="worker-match-list">{declarationResult.matchingData.preliminary_matches.map((match) => <article key={match.code}><strong>{match.title}</strong><small>{match.code}</small><span>Preliminary match · {Math.round((match.similarity_score ?? 0) * 100)}% retrieval similarity</span></article>)}</div> : <p className="empty-result">No suggested module cleared the matching threshold. Your assessor can still review your statement.</p>}
        <p className="worker-results-notice">These are suggestions to help an assessor prepare. They do not measure your ability, decide a result, or provide certification.</p>
      </section>}
    </section>
  )
}

function RoleEntry({ workerName, setWorkerName, assessorName, setAssessorName, onWorkerEnter, onAssessorEnter }) {
  return (
    <main className="role-entry-shell">
      <section className="role-entry-card">
      <div className="brand role-entry-brand"><Innov8Mark /><span>Innov8<small>RECOGNITION OF PRIOR LEARNING</small></span></div>
        <div className="eyebrow">SKILL ASSESSMENT <span>•</span> DEMO</div>
        <h1>How would you like to continue?</h1>
        <p className="role-entry-intro">Workers share experience in their own words. Assessors review evidence and score practical skills in a separate workspace.</p>
        <div className="role-choice-grid">
          <section className="role-choice worker-choice"><div className="role-icon">◫</div><div className="eyebrow">FOR WORKERS</div><h2>Share your experience</h2><p>Tell us about past work by typing or voice. Save your statement offline and see preliminary skill suggestions.</p><label>Your name (optional)<input value={workerName} onChange={(event) => setWorkerName(event.target.value)} placeholder="Enter your name" autoComplete="name" /></label><button className="primary-button" type="button" onClick={onWorkerEnter}>Continue as worker <span>→</span></button></section>
          <section className="role-choice assessor-choice"><div className="role-icon">☷</div><div className="eyebrow">FOR ASSESSORS</div><h2>Review and assess</h2><p>Open the assessor checklist, record evidence-based ratings, and review assessor agreement.</p><label>Assessor display name<input value={assessorName} onChange={(event) => setAssessorName(event.target.value)} placeholder="Enter assessor name" autoComplete="name" /></label><button className="secondary-button" type="button" onClick={onAssessorEnter} disabled={!assessorName.trim()}>Continue to assessor workspace <span>→</span></button></section>
        </div>
        <p className="role-entry-notice">Prototype sign-in: this demo does not verify accounts. Use fictional data only. Real login and role permissions are required before deployment.</p>
      </section>
    </main>
  )
}

function App() {
  const savedEnvelope = readLocalJson(DRAFT_KEY)
  const [workerId, setWorkerId] = useState(savedEnvelope.activeWorkerId ?? savedEnvelope.workerId ?? '')
  const [assessmentMode, setAssessmentMode] = useState(savedEnvelope.assessmentMode ?? 'tool_assisted')
  const scopedInitialDraft = readLocalJson(caseDraftKey(workerId, assessmentMode))
  const savedDraft = { ...savedEnvelope, ...scopedInitialDraft }
  const [worker, setWorker] = useState(null)
  const [role, setRole] = useState(localStorage.getItem(ROLE_KEY) ?? '')
  const [workerNameInput, setWorkerNameInput] = useState(savedEnvelope.workerNameInput ?? '')
  const [workerCaseId] = useState(savedEnvelope.workerCaseId ?? `worker-${createId()}`)
  const [workers, setWorkers] = useState([])
  const [workerIntakes, setWorkerIntakes] = useState([])
  const [checklist, setChecklist] = useState(null)
  const [ratings, setRatings] = useState(savedDraft.ratings ?? {})
  const [notes, setNotes] = useState(savedDraft.notes ?? {})
  const [assessorName, setAssessorName] = useState(savedDraft.assessorName ?? '')
  const [declarationText, setDeclarationText] = useState(savedDraft.declarationText ?? '')
  const [declarationResult, setDeclarationResult] = useState(null)
  const [intakeLanguage, setIntakeLanguage] = useState(savedEnvelope.intakeLanguage ?? 'hi-IN')
  const [photoEvidence, setPhotoEvidence] = useState(null)
  const [activeIntakeId, setActiveIntakeId] = useState('')
  const [intakeStatus, setIntakeStatus] = useState('')
  const [queueCounts, setQueueCounts] = useState({ intakes: 0, assessments: 0 })
  const [clientRecordId, setClientRecordId] = useState(savedDraft.clientRecordId ?? createId())
  const [matching, setMatching] = useState(false)
  const [result, setResult] = useState(null)
  const [syncStatus, setSyncStatus] = useState(savedDraft.syncStatus ?? 'draft')
  const [syncReceiptId, setSyncReceiptId] = useState(savedDraft.syncReceiptId ?? '')
  const [assessorRecommendation, setAssessorRecommendation] = useState(savedDraft.assessorRecommendation ?? 'pending')
  const [reviewRecords, setReviewRecords] = useState([])
  const [consistency, setConsistency] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [draftSaved, setDraftSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function checkBackend() {
      if (!navigator.onLine) {
        setIsOnline(false)
        return
      }
      try {
        const response = await fetch(`${API_BASE}/health`, { cache: 'no-store' })
        setIsOnline(response.ok)
      } catch {
        setIsOnline(false)
      }
    }
    function updateConnection() { checkBackend() }
    window.addEventListener('online', updateConnection)
    window.addEventListener('offline', updateConnection)
    const timer = window.setInterval(checkBackend, 15000)
    checkBackend()
    return () => {
      window.removeEventListener('online', updateConnection)
      window.removeEventListener('offline', updateConnection)
      window.clearInterval(timer)
    }
  }, [])

  async function refreshReviewData() {
    try {
      const [recordsResponse, consistencyResponse] = await Promise.all([
        fetch(`${API_BASE}/assessment/records`),
        fetch(`${API_BASE}/assessment/consistency`),
      ])
      if (!recordsResponse.ok || !consistencyResponse.ok) return
      const recordsData = await recordsResponse.json()
      setReviewRecords(recordsData.records)
      setConsistency(await consistencyResponse.json())
    } catch {
      // Review history is not required to keep a local draft available.
    }
  }

  useEffect(() => { refreshReviewData() }, [])

  useEffect(() => {
    if (role !== 'assessor') return
    let active = true
    async function refreshIntakes() {
      try {
        const response = await fetch(`${API_BASE}/workers/intake`, { cache: 'no-store' })
        if (!response.ok) return
        const data = await response.json()
        if (!active) return
        const intakes = data.intakes ?? []
        const intakeWorkers = [...new Map(intakes.map((intake) => [intake.worker_id, intake])).values()]
          .filter((intake) => intake.worker_id)
          .map((intake) => ({ id: intake.worker_id, name: intake.worker_name || 'Worker intake', trade: 'Assistant Electrician (Domestic cum Industrial)', qualification_name: 'Assistant Electrician (Domestic cum Industrial)', qualification_code: checklist?.qualification_code ?? 'QG-03-PW-02422-2024-V1-MSME', nsqf_level: 3, experience_years: intake.experience_years ?? getExperienceYears(intake.declaration_text), is_worker_intake: true }))
        setWorkerIntakes(intakes)
        setWorkers((current) => [...current.filter((item) => !item.is_worker_intake && item.data_type !== 'fictional_demo_data' && !/^worker-00[1-5]$/.test(item.id) && !intakeWorkers.some((intakeWorker) => intakeWorker.id === item.id)), ...intakeWorkers])
      } catch {
        // Keep previously received worker submissions visible while offline.
      }
    }
    void refreshIntakes()
    const timer = window.setInterval(refreshIntakes, 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [role, checklist?.qualification_code])

  useEffect(() => {
    try {
      const draftData = { ratings, notes, syncStatus, syncReceiptId, assessorRecommendation, clientRecordId }
      localStorage.setItem(caseDraftKey(workerId, assessmentMode), JSON.stringify(draftData))
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ activeWorkerId: workerId, assessorName, declarationText, assessmentMode, assessorRecommendation, intakeLanguage, workerNameInput, workerCaseId }))
      setDraftSaved(true)
    } catch {
      setDraftSaved(false)
    }
  }, [ratings, notes, assessorName, declarationText, syncStatus, syncReceiptId, assessmentMode, assessorRecommendation, workerId, clientRecordId, intakeLanguage, workerNameInput, workerCaseId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveWorkerDraft({ id: `${workerId}:declaration`, workerId, declarationText, intakeLanguage, photoEvidence })
        .catch(() => setDraftSaved(false))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [workerId, declarationText, intakeLanguage, photoEvidence])

  async function refreshQueueCounts() {
    try { setQueueCounts(await getPendingQueueCounts()) } catch { /* IndexedDB may be unavailable */ }
  }

  async function runQueueSync() {
    if (!navigator.onLine) return
    const summary = await syncPendingRecords(API_BASE)
    await refreshQueueCounts()
    if (summary.intakesSynced || summary.assessmentsSynced) {
      const savedIntake = activeIntakeId ? await db.intakeQueue.get(activeIntakeId).catch(() => null) : null
      if (savedIntake?.status === 'synced') {
        const data = savedIntake.serverResponse
        setDeclarationResult({ extraction: { skills: data.skills ?? [], experience_years: data.experience_years, notice: data.notice }, matchingData: { preliminary_matches: data.preliminary_matches ?? [], matching_notice: data.matching_notice, matching_method: data.matching_method }, intakeId: data.intake_id })
        setIntakeStatus('Statement synced for assessor review.')
      }
      const savedAssessment = await db.assessments.get(clientRecordId).catch(() => null)
      if (savedAssessment?.status === 'synced') {
        const data = savedAssessment.serverResponse
        setResult(data)
        setSyncReceiptId(data.record_id)
        setSyncStatus('synced')
      }
      void refreshReviewData()
    }
    return summary
  }

  useEffect(() => {
    refreshQueueCounts()
    const handleOnline = () => { void runQueueSync() }
    window.addEventListener('online', handleOnline)
    const retryTimer = window.setInterval(async () => {
      const counts = await getPendingQueueCounts().catch(() => ({ intakes: 0, assessments: 0 }))
      setQueueCounts(counts)
      if (navigator.onLine && counts.intakes + counts.assessments > 0) void runQueueSync()
    }, 20000)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.clearInterval(retryTimer)
    }
  }, [activeIntakeId, clientRecordId])

  useEffect(() => {
    async function loadAssessment() {
      try {
        const [workersResponse, checklistResponse] = await Promise.all([
          fetch(`${API_BASE}/workers`),
          fetch(`${API_BASE}/assessment/checklist`),
        ])
        if (!workersResponse.ok || !checklistResponse.ok) {
          throw new Error('The prototype API did not return the assessment data.')
        }
        const workers = await workersResponse.json()
        const checklistData = await checklistResponse.json()
        let submittedIntakes = []
        try {
          const intakeResponse = await fetch(`${API_BASE}/workers/intake`, { cache: 'no-store' })
          if (intakeResponse.ok) submittedIntakes = (await intakeResponse.json()).intakes ?? []
        } catch { /* Intake review is optional while offline. */ }
        const intakeWorkers = [...new Map(submittedIntakes.map((intake) => [intake.worker_id, intake])).values()]
          .filter((intake) => intake.worker_id && !workers.some((item) => item.id === intake.worker_id))
          .map((intake) => ({ id: intake.worker_id, name: intake.worker_name || 'Worker intake', trade: 'Assistant Electrician (Domestic cum Industrial)', qualification_name: 'Assistant Electrician (Domestic cum Industrial)', qualification_code: checklistData.qualification_code, nsqf_level: 3, experience_years: intake.experience_years ?? getExperienceYears(intake.declaration_text), is_worker_intake: true }))
        const allWorkers = [...workers.filter((item) => item.data_type !== 'fictional_demo_data' && !/^worker-00[1-5]$/.test(item.id)), ...intakeWorkers]
        setIsOnline(true)
        const selectedWorker = allWorkers.find((item) => item.id === workerId) ?? allWorkers[0] ?? null
        const referenceData = { workers: allWorkers, checklist: checklistData }
        localStorage.setItem(REFERENCE_KEY, JSON.stringify(referenceData))
        setWorkerIntakes(submittedIntakes)
        setWorkers(allWorkers)
        setWorker(selectedWorker)
        setWorkerId(selectedWorker?.id ?? '')
        setChecklist(checklistData)
        const selectedDraft = readLocalJson(caseDraftKey(selectedWorker?.id ?? '', assessmentMode))
        const workerDraft = await db.workerDrafts.get(`${selectedWorker?.id ?? ''}:declaration`).catch(() => null)
        if (workerDraft) {
          setDeclarationText(workerDraft.declarationText ?? '')
          setIntakeLanguage(workerDraft.intakeLanguage ?? 'hi-IN')
          setPhotoEvidence(workerDraft.photoEvidence ?? null)
        }
        setRatings(Object.fromEntries(checklistData.items.map((item) => [item.id, selectedDraft.ratings?.[item.id] ?? 'not_observed'])))
        setNotes(selectedDraft.notes ?? {})
        setSyncStatus(selectedDraft.syncStatus ?? 'draft')
        setSyncReceiptId(selectedDraft.syncReceiptId ?? '')
        setAssessorRecommendation(selectedDraft.assessorRecommendation ?? 'pending')
        setClientRecordId(selectedDraft.clientRecordId ?? createId())
      } catch {
        const cachedReference = readLocalJson(REFERENCE_KEY)
        setIsOnline(false)
        const cachedWorkers = (cachedReference.workers ?? (cachedReference.worker ? [cachedReference.worker] : [])).filter((item) => item.data_type !== 'fictional_demo_data' && !/^worker-00[1-5]$/.test(item.id))
        if (cachedWorkers.length && cachedReference.checklist) {
          const selectedWorker = cachedWorkers.find((item) => item.id === workerId) ?? cachedWorkers[0]
          setWorkers(cachedWorkers)
        setWorker(selectedWorker)
        setWorkerId(selectedWorker.id)
        setChecklist(cachedReference.checklist)
        const selectedDraft = readLocalJson(caseDraftKey(selectedWorker.id, assessmentMode))
        const workerDraft = await db.workerDrafts.get(`${selectedWorker.id}:declaration`).catch(() => null)
        if (workerDraft) {
          setDeclarationText(workerDraft.declarationText ?? '')
          setIntakeLanguage(workerDraft.intakeLanguage ?? 'hi-IN')
          setPhotoEvidence(workerDraft.photoEvidence ?? null)
        }
          setRatings(Object.fromEntries(cachedReference.checklist.items.map((item) => [item.id, selectedDraft.ratings?.[item.id] ?? 'not_observed'])))
          setNotes(selectedDraft.notes ?? {})
          setSyncStatus(selectedDraft.syncStatus ?? 'draft')
          setSyncReceiptId(selectedDraft.syncReceiptId ?? '')
          setAssessorRecommendation(selectedDraft.assessorRecommendation ?? 'pending')
          setClientRecordId(selectedDraft.clientRecordId ?? createId())
        } else {
          setError('Could not load the checklist. Connect to the backend once while online, then refresh to enable offline use.')
        }
      } finally {
        setLoading(false)
      }
    }
    loadAssessment()
  }, [])

  const completedCount = useMemo(
    () => Object.values(ratings).filter((rating) => rating !== 'not_observed').length,
    [ratings],
  )
  const ratingSummary = useMemo(() => {
    const applicable = Object.values(ratings).filter((rating) => rating !== 'not_observed')
    const counts = {
      demonstrated: applicable.filter((rating) => rating === 'demonstrated').length,
      partially_demonstrated: applicable.filter((rating) => rating === 'partially_demonstrated').length,
      not_demonstrated: applicable.filter((rating) => rating === 'not_demonstrated').length,
    }
    const score = applicable.length ? Math.round(((counts.demonstrated * 2 + counts.partially_demonstrated) / (applicable.length * 2)) * 100) : null
    return { counts, applicable: applicable.length, score }
  }, [ratings])
  const safetyConcerns = useMemo(
    () => (checklist?.items ?? []).filter((item) => /safe|safety/i.test(item.criterion) && ratings[item.id] === 'not_demonstrated'),
    [checklist, ratings],
  )

  async function submitAssessment(event) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setResult(null)
    try {
      const payload = {
          client_record_id: clientRecordId,
          worker_id: worker.id,
          assessor_name: assessorName.trim(),
          assessment_mode: assessmentMode,
          assessor_recommendation: assessorRecommendation,
          ratings: checklist.items.map((item) => ({
            criterion_id: item.id,
            rating: ratings[item.id],
            assessor_note: notes[item.id] ?? '',
          })),
        }
      await queueAssessment(payload)
      setSyncStatus('pending')
      await refreshQueueCounts()
      if (!navigator.onLine) {
        setError('Ratings are saved on this device and will sync when the connection returns.')
        return
      }
      const summary = await runQueueSync()
      const saved = await db.assessments.get(clientRecordId)
      if (saved?.status === 'synced') {
        setIsOnline(true)
        setResult(saved.serverResponse)
        setSyncReceiptId(saved.serverResponse.record_id)
        setSyncStatus('synced')
        setClientRecordId(createId())
      } else if (summary?.errors?.length) {
        setError('Ratings are safely queued on this device. Sync will retry when the backend is available.')
      }
    } catch (submitError) {
      setIsOnline(false)
      setSyncStatus('pending')
      setError(submitError.message || 'Could not queue the assessment on this device.')
    } finally {
      setSaving(false)
    }
  }

  async function submitDeclaration(event) {
    event.preventDefault()
    setMatching(true)
    setError('')
    setDeclarationResult(null)
    try {
      const intakeId = activeIntakeId || createId()
      setActiveIntakeId(intakeId)
      const portalSubmission = role === 'worker'
      await queueWorkerIntake({ intake_id: intakeId, worker_id: portalSubmission ? workerCaseId : worker.id, worker_name: portalSubmission ? (workerNameInput.trim() || 'Worker') : worker.name, channel: 'web', language: intakeLanguage, declaration_text: declarationText, evidence_media_data_url: photoEvidence?.dataUrl ?? null, latitude: photoEvidence?.latitude ?? null, longitude: photoEvidence?.longitude ?? null, captured_at_utc: photoEvidence?.capturedAtUtc ?? null })
      setIntakeStatus('Saved on this device. Waiting to sync.')
      await refreshQueueCounts()
      if (!navigator.onLine) return
      const summary = await runQueueSync()
      const saved = await db.intakeQueue.get(intakeId)
      if (saved?.status === 'synced') {
        setIsOnline(true)
        const data = saved.serverResponse
        setDeclarationResult({ extraction: { skills: data.skills ?? [], experience_years: data.experience_years, notice: data.notice }, matchingData: { preliminary_matches: data.preliminary_matches ?? [], matching_notice: data.matching_notice, matching_method: data.matching_method }, intakeId })
        setIntakeStatus('Statement synced for assessor review.')
      } else if (summary?.errors?.length) setIntakeStatus('Saved on this device. Sync will retry when the backend is available.')
    } catch (declarationError) {
      setIsOnline(false)
      setError(!navigator.onLine
        ? 'You are offline. The statement is saved on this device and can be processed after reconnecting.'
        : (declarationError.message || 'Could not process the worker statement.'))
    } finally {
      setMatching(false)
    }
  }

  function loadContextDraft(nextWorkerId, nextMode) {
    const draft = readLocalJson(caseDraftKey(nextWorkerId, nextMode))
    setRatings(Object.fromEntries((checklist?.items ?? []).map((item) => [item.id, draft.ratings?.[item.id] ?? 'not_observed'])))
    setNotes(draft.notes ?? {})
    setSyncStatus(draft.syncStatus ?? 'draft')
    setSyncReceiptId(draft.syncReceiptId ?? '')
    setAssessorRecommendation(draft.assessorRecommendation ?? 'pending')
    setClientRecordId(draft.clientRecordId ?? createId())
    setResult(null)
  }

  function selectWorker(nextWorkerId) {
    const nextWorker = workers.find((item) => item.id === nextWorkerId)
    if (!nextWorker) return
    loadContextDraft(nextWorker.id, assessmentMode)
    setWorker(nextWorker)
    setWorkerId(nextWorker.id)
    setDeclarationText('')
    setDeclarationResult(null)
    setPhotoEvidence(null)
    setActiveIntakeId('')
    setIntakeStatus('')
  }

  function selectAssessmentMode(nextMode) {
    loadContextDraft(workerId, nextMode)
    setAssessmentMode(nextMode)
  }

  function enterRole(nextRole) {
    localStorage.setItem(ROLE_KEY, nextRole)
    setRole(nextRole)
    window.location.hash = nextRole === 'worker' ? 'worker-intake' : 'checklist'
  }

  function signOut() {
    localStorage.removeItem(ROLE_KEY)
    setRole('')
    window.location.hash = 'top'
  }

  if (!role) return <RoleEntry workerName={workerNameInput} setWorkerName={setWorkerNameInput} assessorName={assessorName} setAssessorName={setAssessorName} onWorkerEnter={() => enterRole('worker')} onAssessorEnter={() => enterRole('assessor')} />

  return (
    <div className="app-shell">
      {role === 'assessor' && <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Innov8 home">
          <Innov8Mark />
          <span>Innov8<small>RPL ASSESSMENT</small></span>
        </a>
        <div className="sidebar-label">WORKSPACE</div>
        <button className="nav-item selected" type="button"><span>☷</span> Assessor workspace</button>
        <div className="sidebar-bottom">
          <span className="demo-dot" /> Prototype mode
          <small>Local demo • fictional data</small>
        </div>
      </aside>}

      <main className="main-content" id="top">
        <header className="topbar">
          <div>{role === 'worker' ? <><span className="breadcrumb">Innov8</span><span className="crumb-divider">/</span> Worker portal</> : <><span className="breadcrumb">Assessments</span><span className="crumb-divider">/</span> New assessment</>}</div>
          <div className="topbar-actions"><span className={`offline-pill ${isOnline ? '' : 'offline'}`}><span /> {isOnline ? 'ONLINE' : 'OFFLINE'}</span><button className="sign-out-button" type="button" onClick={signOut}>Change role</button></div>
        </header>

        <div className="page-content">
          {role === 'assessor' ? <section className="page-heading">
            <div>
              <div className="eyebrow">ASSESSOR WORKSPACE <span>•</span> DEMO</div>
              <h1>{assessmentMode === 'manual_baseline' ? 'Manual baseline assessment' : 'Tool-assisted assessment'}</h1>
              <p>{assessmentMode === 'manual_baseline' ? 'No AI suggestions are shown. Score the same qualification criteria yourself for a fair comparison.' : 'AI shows preliminary skill and module suggestions. You review them, then score the same qualification criteria yourself.'}</p>
            </div>
            <div className="step-chip"><span>1</span> Assessment in progress</div>
          </section> : <section className="page-heading worker-page-heading">
            <div><div className="eyebrow">INNOV8 <span>•</span> WORKER WEB APP</div><h1>Start with your experience</h1><p>No formal documents needed to tell us what work you have done.</p></div>
            <div className="step-chip"><span>1</span> Your story</div>
          </section>}

          {error && <div className="alert" role="alert">{error}</div>}
          {!isOnline && <div className="offline-banner" role="status"><strong>Offline mode</strong><span>Your saved checklist and draft remain available on this device. API matching and summary sync need a connection.</span></div>}
          {loading && <div className="loading-card">Loading worker and assessment criteria…</div>}

          {!loading && role === 'worker' && <WorkerIntakeWorkspace
            declarationText={declarationText}
            setDeclarationText={setDeclarationText}
            intakeLanguage={intakeLanguage}
            setIntakeLanguage={setIntakeLanguage}
            photoEvidence={photoEvidence}
            setPhotoEvidence={setPhotoEvidence}
            workerName={workerNameInput}
            setWorkerName={setWorkerNameInput}
            matching={matching}
            onSubmit={submitDeclaration}
            draftSaved={draftSaved}
            intakeStatus={intakeStatus}
            queueCount={queueCounts.intakes}
            declarationResult={declarationResult}
            onStatementChanged={() => { if (intakeStatus.startsWith('Statement synced')) { setActiveIntakeId(''); setIntakeStatus('') } }}
          />}

          {!loading && role === 'assessor' && !worker && <section className="empty-worker-state"><span className="empty-worker-icon">∞</span><h2>No worker submissions yet</h2><p>When a worker submits their experience in the Worker portal, their case will appear here for assessment.</p><button className="secondary-button" type="button" onClick={() => enterRole('worker')}>Open Worker portal <span>→</span></button></section>}
          {!loading && role === 'assessor' && worker && checklist && (
            <>
              <section className="worker-card" id="worker">
                <div className="worker-avatar">{worker.name.split(' ').map((part) => part[0]).join('')}</div>
                <div className="worker-main">
                  <div className="worker-name-row"><h2>{worker.name}</h2><span className="fictional-badge">{worker.is_worker_intake ? 'WORKER SUBMISSION' : 'FICTIONAL DEMO'}</span></div>
                  <p>{worker.trade} <span>•</span> {worker.experience_years == null ? 'Experience not stated' : `${worker.experience_years} years of experience`}</p>
                  <label className="worker-switch">Worker case<select value={worker.id} onChange={(event) => selectWorker(event.target.value)}>{workers.map((item) => <option key={item.id} value={item.id}>{item.is_worker_intake ? 'Worker submission' : item.id} · {item.name}</option>)}</select></label>
                </div>
                <div className="qualification-block">
                  <span>QUALIFICATION</span>
                  <strong>{worker.qualification_name}</strong>
                  <small>{worker.qualification_code} <span>•</span> NSQF Level {worker.nsqf_level}</small>
                </div>
              </section>

              <section className="mode-panel">
                <div><div className="eyebrow">EVALUATION MODE</div><strong>Choose how this assessment is scored</strong><p>For a fair comparison, use the same worker, criteria, and assessor names in both modes.</p></div>
                <div className="mode-options" role="group" aria-label="Assessment mode">
                  <label className={assessmentMode === 'tool_assisted' ? 'mode-option active' : 'mode-option'}><input type="radio" name="assessment-mode" value="tool_assisted" checked={assessmentMode === 'tool_assisted'} onChange={() => selectAssessmentMode('tool_assisted')} /><span><strong>Tool-assisted · AI visible</strong><small>Shows extracted skills, module matches, similarity signals, and review warnings. You make every rating.</small></span></label>
                  <label className={assessmentMode === 'manual_baseline' ? 'mode-option active' : 'mode-option'}><input type="radio" name="assessment-mode" value="manual_baseline" checked={assessmentMode === 'manual_baseline'} onChange={() => selectAssessmentMode('manual_baseline')} /><span><strong>Manual baseline · AI hidden</strong><small>Same declaration and checklist, without AI analysis. Use to compare assessor agreement.</small></span></label>
                </div>
                <div className="mode-help"><strong>What happens after saving?</strong><span>Each save creates a separate record labeled with its mode. Find it under <b>Synced records</b>. To compare fairly, use the same worker and assessors in both modes. Saving does not certify the worker.</span></div>
              </section>

              <section className="declaration-panel">
                <div className="panel-heading">
                  <div><div className="eyebrow">WORKER SUBMISSION <span>•</span> ASSESSOR VIEW</div><h2>Worker self-declaration</h2></div>
                  <span className="item-count">READ ONLY</span>
                </div>
                {(() => {
                  const intake = workerIntakes.filter((item) => item.worker_id === worker.id).sort((a, b) => String(b.saved_at_utc).localeCompare(String(a.saved_at_utc)))[0]
                  return intake ? <>
                    <p className="declaration-intro">Submitted by the worker through the separate intake portal. This statement is read-only worker context; it is not an assessor rating or proof of competence.</p>
                    <blockquote>{intake.declaration_text}</blockquote>
                    {(intake.evidence_media || intake.evidence_photo) && <div className="assessor-evidence"><div className="result-subheading">WORKER-SUBMITTED EVIDENCE</div>{(intake.evidence_media_type === 'video' || intake.evidence_media?.match(/\.(mp4|webm|mov)$/i)) ? <video src={`${API_BASE}${intake.evidence_media || intake.evidence_photo}`} controls preload="metadata" aria-label="Worker-submitted video evidence" /> : <a href={`${API_BASE}${intake.evidence_media || intake.evidence_photo}`} target="_blank" rel="noreferrer"><img src={`${API_BASE}${intake.evidence_media || intake.evidence_photo}`} alt="Worker-submitted photo evidence" /></a>}<small>Submitted by worker · review authenticity and relevance yourself</small></div>}
                    {assessmentMode === 'tool_assisted' ? <div className="intake-analysis">
                      <div className="result-subheading">AI PRE-SCREEN · ASSESSOR MUST VERIFY</div>
                      {intake.skills?.length ? <div className="skill-chips">{intake.skills.map((skill) => <span key={skill}>{skill}</span>)}</div> : <p className="empty-result">No supported skill terms were extracted from the statement.</p>}
                      <div className="ai-warning-list"><strong>Review checks</strong><ul>{!intake.skills?.length && <li>No skill terms were extracted. Read the full statement and ask follow-up questions.</li>}{!intake.experience_years && <li>Years of experience were not identified; confirm this with the worker.</li>}{!intake.preliminary_matches?.length && <li>No qualification module matched strongly. Review the original statement against the qualification criteria.</li>}{intake.matching_method === 'demo_text_overlap_fallback' && <li>Semantic model is unavailable. Suggestions use basic word overlap and may miss equivalent wording or languages.</li>}{(intake.preliminary_matches?.[0]?.similarity_score ?? 0) < 0.3 && intake.preliminary_matches?.length > 0 && <li>Top module similarity is weak. Treat this suggestion as a search lead only.</li>}{!intake.evidence_media && !intake.evidence_photo && <li>No photo or video was submitted. Observe the worker against the practical checklist.</li>}</ul></div>
                      {intake.experience_years != null && <p className="experience-found">Experience stated: <strong>{intake.experience_years} years</strong></p>}
                      {intake.preliminary_matches?.length > 0 && <div className="module-matches"><div className="result-subheading">PRELIMINARY NQR MODULE MATCHES</div>{intake.preliminary_matches.map((match) => <div className="module-match" key={match.code}><div><strong>{match.title}</strong><small>{match.code}</small></div><span>{Math.round((match.similarity_score ?? 0) * 100)}% text similarity</span></div>)}<p className="match-caveat">Text similarity is an uncalibrated retrieval signal—not confidence, a worker skill score, or evidence of competence. Review the mapped criteria yourself.</p></div>}
                      {intake.matching_notice && <small className="match-caveat">{intake.matching_notice}</small>}
                    </div> : <p className="declaration-intro">Manual baseline: the same worker statement is available, while AI extraction and module suggestions are hidden.</p>}
                  </> : <p className="declaration-intro">No worker statement is linked to this case yet. Ask the worker to submit it through the separate Worker portal. New submissions appear here after they sync.</p>
                })()}
              </section>

              <div className="assessment-layout">
                <form className="checklist-panel" id="checklist" onSubmit={submitAssessment}>
                  <div className="panel-heading">
                    <div><div className="eyebrow">ASSESSOR GUIDANCE</div><h2>Competency checklist</h2></div>
                    <span className="item-count">{checklist.items.length} CRITERIA</span>
                  </div>
                  <div className="source-note">Adapted from the qualification file. Use approved equipment and follow assessment safety controls.</div>

                  {safetyConcerns.length > 0 && <div className="ai-warning-list" role="alert"><strong>Safety-related criteria need assessor attention</strong><ul>{safetyConcerns.map((item) => <li key={item.id}>{item.criterion} — recorded as Not demonstrated. Verify the observation and follow the approved assessment protocol.</li>)}</ul></div>}

                  <div className="progress-row"><span>{completedCount} of {checklist.items.length} rated</span><div className="progress-track"><i style={{ width: `${(completedCount / checklist.items.length) * 100}%` }} /></div></div>

                  <label className="assessor-field">Assessor name<input value={assessorName} onChange={(event) => { setAssessorName(event.target.value); setSyncStatus('draft'); setResult(null) }} placeholder="Enter assessor name" required /></label>
                  <label className="recommendation-field">Assessor recommendation (human sign-off)<select value={assessorRecommendation} onChange={(event) => { setAssessorRecommendation(event.target.value); setSyncStatus('draft'); setResult(null) }}><option value="pending">Pending assessor review</option><option value="recommend_for_certification_review">Recommend for certification review</option><option value="request_additional_evidence">Request additional evidence</option><option value="not_recommending_yet">Not recommending yet</option></select><small>This is the assessor’s recorded recommendation; the tool does not issue certification.</small></label>

                  <div className="criteria-list">
                    {checklist.items.map((item, index) => (
                      <article className="criterion-card" key={item.id}>
                        <div className="criterion-top"><span className="criterion-number">{String(index + 1).padStart(2, '0')}</span><span className="criterion-code">{item.module_code} · {item.criterion_reference}</span></div>
                        <h3>{item.criterion}</h3>
                        <p className="evidence-prompt"><strong>Observe:</strong> {item.evidence_prompt}</p>
                        <div className="rating-options" role="group" aria-label={`Rating for ${item.criterion}`}>
                          {checklist.rating_options.map((option) => (
                            <label className={`rating-option ${ratings[item.id] === option.value ? 'active' : ''}`} key={option.value}>
                              <input type="radio" name={item.id} value={option.value} checked={ratings[item.id] === option.value} onChange={() => { setRatings((current) => ({ ...current, [item.id]: option.value })); setSyncStatus('draft'); setResult(null) }} />
                              {option.label}
                            </label>
                          ))}
                        </div>
                        <label className="note-field">Assessor observation<textarea value={notes[item.id] ?? ''} onChange={(event) => { setNotes((current) => ({ ...current, [item.id]: event.target.value })); setSyncStatus('draft'); setResult(null) }} placeholder="Add a brief evidence note (optional)" rows="2" /></label>
                      </article>
                    ))}
                  </div>
                  <div className="submit-row"><span>{completedCount === 0 ? 'Rate at least one observed criterion before syncing.' : syncStatus === 'synced' ? `Saved to local review history · ${assessmentMode === 'manual_baseline' ? 'Manual baseline' : 'Tool-assisted'}. No certificate is issued.` : syncStatus === 'pending' ? 'Saved on this device; waiting for sync.' : 'Draft is saved on this device. Sync when the backend is available.'}</span><button className="primary-button" type="submit" disabled={saving || !worker || completedCount === 0}>{saving ? 'Saving ratings…' : syncStatus === 'synced' ? 'Sync updated ratings' : assessmentMode === 'manual_baseline' ? 'Save manual baseline' : 'Save tool-assisted ratings'} <span>→</span></button></div>
                </form>

                <aside className="side-column">
                  <section className="info-card score-card"><div className="info-card-heading"><span>ASSESSOR RATING SUMMARY</span><span className="verified-tag">{assessmentMode === 'manual_baseline' ? 'MANUAL' : 'AI ASSISTED'}</span></div><div className="score-large">{ratingSummary.score == null ? '—' : `${ratingSummary.score}%`}</div><strong>{ratingSummary.applicable ? `${ratingSummary.applicable} observed criteria rated` : 'No observed criteria rated yet'}</strong><div className="score-breakdown"><span>Demonstrated <b>{ratingSummary.counts.demonstrated}</b></span><span>Partial <b>{ratingSummary.counts.partially_demonstrated}</b></span><span>Not demonstrated <b>{ratingSummary.counts.not_demonstrated}</b></span><span>Not observed <b>{checklist.items.length - ratingSummary.applicable}</b></span></div><small>Prototype rubric indicator: demonstrated = 2 points, partial = 1, not demonstrated = 0; not observed excluded. This is not an official NSQF score or certification threshold.</small></section>
                  <section className="info-card human-card"><div className="info-icon">◎</div><h3>Assessor decision stays with you</h3><p>This tool organizes evidence and ratings. It does not decide competence or issue certification.</p></section>
                  <section className="info-card"><div className="info-card-heading"><span>ASSESSMENT SOURCE</span><span className="verified-tag">NQR</span></div><strong>Assistant Electrician (Domestic cum Industrial)</strong><p>Qualification code<br /><code>{checklist.qualification_code}</code></p><a href={checklist.source_url} target="_blank" rel="noreferrer">Open qualification file ↗</a></section>
                  <section className="info-card"><div className="info-card-heading"><span>RATING GUIDE</span></div><ul className="legend-list"><li><i className="legend green" /> Demonstrated</li><li><i className="legend amber" /> Partially demonstrated</li><li><i className="legend red" /> Not demonstrated</li><li><i className="legend gray" /> Not observed</li></ul></section>
                  {result && <section className="result-card" aria-live="polite"><div className="result-heading"><span>✓</span><strong>Ratings synced for review · {assessmentMode === 'manual_baseline' ? 'Manual baseline' : 'Tool-assisted'}</strong></div><p>{result.ratings_received} criteria saved on the local server.</p><div className="saved-score"><strong>Rubric indicator: {result.score_indicator_percent ?? ratingSummary.score ?? '—'}%</strong><small>{result.applicable_criteria ?? ratingSummary.applicable} observed criteria · {result.score_method ?? 'Demonstrated=2, partial=1, not demonstrated=0; not observed excluded'}</small></div><p><strong>Assessor recommendation:</strong> {result.assessor_recommendation?.replaceAll('_', ' ') ?? 'pending'}</p><p className="receipt-id">Receipt: {syncReceiptId}</p><div className="count-grid">{Object.entries(result.rating_counts).map(([rating, count]) => <div key={rating}><b>{count}</b><span>{rating.replaceAll('_', ' ')}</span></div>)}</div><div className="decision-needed">{result.score_notice ?? 'Prototype indicator only—not an official NSQF score or certification decision.'}</div></section>}
                  <section className="info-card consistency-card"><div className="info-card-heading"><span>ASSESSOR CONSISTENCY</span><span className="verified-tag">DEMO</span></div>{consistency?.mode_summaries?.map((summary) => <div className="mode-summary" key={summary.assessment_mode}><strong>{summary.assessment_mode === 'manual_baseline' ? 'Manual baseline' : 'Tool-assisted'}: {summary.exact_agreement_percent == null ? 'No comparison yet' : `${summary.exact_agreement_percent}% exact agreement`}</strong><small>{summary.assessor_pairs} assessor pairs · {summary.criteria_compared} criteria compared</small></div>)}{consistency?.paired_mode_summary ? <div className="paired-summary"><strong>Matched comparison · {consistency.paired_mode_summary.difference_percentage_points > 0 ? '+' : ''}{consistency.paired_mode_summary.difference_percentage_points} percentage points assisted</strong><p>Manual {consistency.paired_mode_summary.manual_agreement_percent}% → tool-assisted {consistency.paired_mode_summary.tool_assisted_agreement_percent}%<br />{consistency.paired_mode_summary.matched_cases} matched case/pair(s) · {consistency.paired_mode_summary.manual_criteria_compared} criteria rated in both modes</p></div> : <p>To compare modes fairly, the same two assessors must independently score the same test case in both modes.</p>}{consistency?.pair_results?.length ? consistency.pair_results.map((pair, index) => <div className="agreement-row" key={`${pair.assessment_mode}-${pair.first_assessor}-${pair.second_assessor}-${index}`}><strong>{pair.exact_agreement_percent}% · {pair.assessment_mode === 'manual_baseline' ? 'manual' : 'assisted'}</strong><p>{pair.first_assessor} and {pair.second_assessor}<br />{pair.agreements} of {pair.criteria_compared} criteria matched</p></div>) : <p>{reviewRecords.length === 0 ? 'No synced assessments yet.' : `${reviewRecords.length} ${reviewRecords.length === 1 ? 'assessment is' : 'assessments are'} stored, but they do not include two different assessor names for the same worker, qualification, and mode.`} Ask a second assessor to independently rate the same test case in each mode.</p>}{consistency?.paired_mode_differences?.map((difference, index) => <div className="agreement-row paired-difference" key={`${difference.worker_id}-${index}`}><strong>Assisted change: {difference.difference_percentage_points > 0 ? '+' : ''}{difference.difference_percentage_points} points</strong><p>Manual {difference.manual_agreement_percent}% → assisted {difference.tool_assisted_agreement_percent}%<br />Same assessor pair and worker · {difference.criteria_compared_in_both_modes} criteria rated in both</p></div>)}<small>{consistency?.interpretation ?? 'Agreement is descriptive; it does not prove improvement over manual scoring.'}</small></section>
                  {reviewRecords.length > 0 && <section className="info-card"><div className="info-card-heading"><span>SYNCED RECORDS</span><span className="verified-tag">{reviewRecords.length}</span></div>{reviewRecords.slice(-3).reverse().map((record) => <div className="record-row" key={record.record_id}><span><strong>{record.assessor_name}</strong><small>{record.assessment_mode === 'manual_baseline' ? 'Manual baseline' : 'Tool-assisted'} · {record.assessor_recommendation?.replaceAll('_', ' ') ?? 'pending'}</small></span><small>{new Date(record.synced_at).toLocaleString()}</small></div>)}</section>}
                </aside>
              </div>
          <footer className="page-footer">INNOV8 PROTOTYPE <span>•</span> Demo workflow using fictional worker data</footer>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

export default App
