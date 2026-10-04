import json
import re
import base64
import binascii
import os

from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import uuid4
from datetime import datetime, timezone
from itertools import combinations

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from supabase import create_client, Client

from services.qp_matcher import match_qualification_pack, matcher_status
from services.whatsapp import inbox_summary, process_webhook_payload, verify_signature, webhook_ready

app = FastAPI(title="RPL Skill Assessment Prototype")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
    raise RuntimeError("Supabase environment variables are not configured.")

supabase: Client = create_client(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
        "https://innov8-rpl.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SkillExtractionRequest(BaseModel):
    text: str


class SkillMatchingRequest(BaseModel):
    skills: list[str] = Field(default_factory=list)
    text: str = Field(default="", max_length=12000)


class WorkerIntakeRequest(BaseModel):
    intake_id: str = Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    worker_id: str = Field(default="worker-001", min_length=1, max_length=80)
    worker_name: str = Field(default="", max_length=120)
    channel: Literal["web", "whatsapp", "demo"] = "web"
    language: str = Field(default="en-IN", max_length=20)
    declaration_text: str = Field(min_length=1, max_length=12000)
    evidence_photo_data_url: str | None = None
    evidence_media_data_url: str | None = Field(default=None, max_length=11_200_050)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    captured_at_utc: str | None = Field(default=None, max_length=40)


AssessmentRating = Literal[
    "demonstrated", "partially_demonstrated", "not_demonstrated", "not_observed"
]
AssessmentMode = Literal["tool_assisted", "manual_baseline"]
AssessorRecommendation = Literal[
    "pending", "recommend_for_certification_review", "request_additional_evidence", "not_recommending_yet"
]


class CriterionRating(BaseModel):
    criterion_id: str
    rating: AssessmentRating
    assessor_note: str = Field(default="", max_length=1000)


class AssessmentScoringRequest(BaseModel):
    client_record_id: str | None = Field(default=None, max_length=80)
    worker_id: str
    assessor_name: str = Field(min_length=1, max_length=120)
    assessment_mode: AssessmentMode = "tool_assisted"
    assessor_recommendation: AssessorRecommendation = "pending"
    ratings: list[CriterionRating]


QP_DATA_PATH = Path(__file__).parent / "data" / "assistant_electrician_nqr_demo.json"
with QP_DATA_PATH.open(encoding="utf-8") as qp_file:
    NQR_QUALIFICATION_DATA = json.load(qp_file)

CHECKLIST_PATH = Path(__file__).parent / "data" / "assessment_checklist.json"
with CHECKLIST_PATH.open(encoding="utf-8") as checklist_file:
    ASSESSMENT_CHECKLIST = json.load(checklist_file)

ASSESSMENT_RECORDS_PATH = Path(__file__).parent / "data" / "assessment_records.json"
ASSESSMENT_RECORDS_LOCK = Lock()
WORKER_INTAKES_PATH = Path(__file__).parent / "data" / "worker_intakes.json"
WORKER_INTAKES_LOCK = Lock()
WORKER_EVIDENCE_DIR = Path(__file__).parent / "data" / "intake_evidence"


@app.get("/health")
def health_check() -> dict[str, str]:
    """Return a small status response so we can confirm the API is running."""
    return {"status": "ok", "service": "rpl-prototype-api"}


@app.get("/workers")
def list_workers() -> list[dict[str, object]]:
    """Return no fabricated workers; worker cases are created from submitted intakes."""
    return []


@app.post("/skills/extract")
def extract_skills(request: SkillExtractionRequest) -> dict[str, object]:
    """Extract a few known phrases using simple demo rules, without an AI model."""
    statement = request.text.casefold()
    skills: list[str] = []

    if "wiring" in statement:
        skills.append("house wiring")
    if "mcb" in statement:
        skills.append("MCB installation")
    if "fan" in statement:
        skills.append("ceiling fan repair")

    years_match = re.search(r"\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:years?|yrs?)\b", statement, re.IGNORECASE)
    years_value = years_match.group(1).lower() if years_match else None
    number_words = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}
    experience_years = (int(years_value) if years_value.isdigit() else number_words[years_value]) if years_value else None

    return {
        "skills": skills,
        "experience_years": experience_years,
        "trade": "Assistant Electrician (Domestic cum Industrial)" if skills else None,
        "method": "deterministic_demo_rules",
        "notice": "Prototype-only extraction; this is not an official assessment.",
    }


@app.post("/matching/preview")
def preview_qp_matches(request: SkillMatchingRequest) -> dict[str, object]:
    """Return ranked, preliminary NQR module matches; assessor review is required."""
    submitted_text = "\n".join(
        part.strip() for part in [request.text, *request.skills] if part.strip()
    )
    ranked_matches = match_qualification_pack(submitted_text)

    return {
        "qualification": ranked_matches["qualification"],
        "preliminary_matches": ranked_matches["matches"],
        "unmatched_skills": ranked_matches["unmatched_terms"],
        "matching_method": ranked_matches["method"],
        "matching_notice": ranked_matches["notice"],
        "source_url": NQR_QUALIFICATION_DATA["source_url"],
        "notice": NQR_QUALIFICATION_DATA["notice"],
    }


@app.get("/matching/status")
def get_matching_status() -> dict[str, object]:
    """Report whether the optional local embedding model is available."""
    return matcher_status()


@app.get("/webhooks/whatsapp", response_class=PlainTextResponse)
def verify_whatsapp_webhook(request: Request) -> str:
    """Handle Meta's one-time callback verification handshake."""
    import os

    verify_token = os.getenv("WHATSAPP_VERIFY_TOKEN", "")
    query = request.query_params
    if not verify_token:
        raise HTTPException(status_code=503, detail="WhatsApp webhook is not configured.")
    if query.get("hub.mode") == "subscribe" and query.get("hub.verify_token") == verify_token:
        return query.get("hub.challenge", "")
    raise HTTPException(status_code=403, detail="Webhook verification failed.")


@app.post("/webhooks/whatsapp")
async def receive_whatsapp_webhook(request: Request, background_tasks: BackgroundTasks) -> dict[str, str]:
    """Validate the Meta signature and queue a compact intake processing task."""
    raw_body = await request.body()
    if len(raw_body) > 1_000_000:
        raise HTTPException(status_code=413, detail="Webhook payload is too large.")
    if not verify_signature(raw_body, request.headers.get("X-Hub-Signature-256")):
        raise HTTPException(status_code=401, detail="Webhook signature is missing or invalid.")
    try:
        payload = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(status_code=400, detail="Webhook payload must be valid JSON.") from error
    if payload.get("object") != "whatsapp_business_account":
        raise HTTPException(status_code=400, detail="Unsupported webhook object.")
    background_tasks.add_task(process_webhook_payload, payload, save_worker_intake, WorkerIntakeRequest)
    return {"status": "accepted"}


@app.get("/whatsapp/status")
def get_whatsapp_status() -> dict[str, object]:
    """Show setup readiness and recent sanitized webhook states to the assessor."""
    return inbox_summary()


@app.post("/workers/intake")
def save_worker_intake(request: WorkerIntakeRequest) -> dict[str, object]:
    """Save a worker self-declaration to Supabase and return preliminary matches."""

    # Prevent duplicate submissions.
    existing_result = (
        supabase
        .table("worker_intakes")
        .select("*")
        .eq("intake_id", request.intake_id)
        .limit(1)
        .execute()
    )

    if existing_result.data:
        existing = existing_result.data[0]

        return {
            "intake_id": existing["intake_id"],
            "worker_id": existing["worker_id"],
            "worker_name": existing.get("worker_name") or "",
            "channel": existing.get("channel") or "web",
            "language": existing.get("language") or "en-IN",
            "declaration_text": existing["declaration_text"],
            "skills": [],
            "experience_years": None,
            "preliminary_matches": [],
            "matching_method": "stored_record",
            "matching_notice": "Existing worker intake returned from Supabase.",
            "evidence_photo": None,
            "evidence_media": None,
            "evidence_media_type": None,
            "latitude": existing.get("latitude"),
            "longitude": existing.get("longitude"),
            "captured_at_utc": existing.get("captured_at_utc"),
            "saved_at_utc": existing.get("saved_at_utc"),
            "assessor_review_required": True,
            "notice": "Self-declaration saved for assessor review. Skill matches are preliminary and do not establish competence or certification.",
        }

    # Keep the existing evidence validation/storage for now.
    evidence_name = None
    extension = None
    evidence_data_url = (
        request.evidence_media_data_url
        or request.evidence_photo_data_url
    )

    if evidence_data_url:
        header, separator, encoded = evidence_data_url.partition(",")

        supported_headers = {
            "data:image/jpeg;base64": ".jpg",
            "data:image/png;base64": ".png",
            "data:image/webp;base64": ".webp",
            "data:video/mp4;base64": ".mp4",
            "data:video/webm;base64": ".webm",
            "data:video/quicktime;base64": ".mov",
        }

        if not separator or header not in supported_headers:
            raise HTTPException(
                status_code=400,
                detail="Evidence must be a JPEG, PNG, WebP, MP4, WebM, or MOV data URL.",
            )

        maximum_encoded_size = (
            11_200_000
            if header.startswith("data:video/")
            else 5_600_000
        )

        if len(encoded) > maximum_encoded_size:
            raise HTTPException(
                status_code=413,
                detail="Photos must be smaller than 4 MB and videos smaller than 8 MB.",
            )

        try:
            evidence_bytes = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError) as error:
            raise HTTPException(
                status_code=400,
                detail="Evidence data is invalid.",
            ) from error

        extension = supported_headers[header]

        valid_signatures = {
            ".jpg": evidence_bytes.startswith(b"\xff\xd8\xff"),
            ".png": evidence_bytes.startswith(b"\x89PNG\r\n\x1a\n"),
            ".webp": evidence_bytes.startswith(b"RIFF")
            and evidence_bytes[8:12] == b"WEBP",
            ".mp4": len(evidence_bytes) > 12
            and evidence_bytes[4:8] == b"ftyp",
            ".mov": len(evidence_bytes) > 12
            and evidence_bytes[4:8] == b"ftyp",
            ".webm": evidence_bytes.startswith(b"\x1a\x45\xdf\xa3"),
        }

        if not valid_signatures[extension]:
            raise HTTPException(
                status_code=400,
                detail="Evidence content does not match its declared file type.",
            )

        WORKER_EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)

        evidence_name = f"{request.intake_id}{extension}"
        (WORKER_EVIDENCE_DIR / evidence_name).write_bytes(evidence_bytes)

    # Run the existing prototype analysis.
    extraction = extract_skills(
        SkillExtractionRequest(text=request.declaration_text)
    )

    match_result = match_qualification_pack(
        request.declaration_text
    )

    saved_at = datetime.now(timezone.utc).isoformat()

    response = {
        "intake_id": request.intake_id,
        "worker_id": request.worker_id,
        "worker_name": request.worker_name,
        "channel": request.channel,
        "language": request.language,
        "declaration_text": request.declaration_text,
        "skills": extraction["skills"],
        "experience_years": extraction["experience_years"],
        "preliminary_matches": match_result["matches"],
        "matching_method": match_result["method"],
        "matching_notice": match_result["notice"],
        "evidence_photo": (
            f"/workers/intake/{request.intake_id}/evidence"
            if evidence_name and extension in {".jpg", ".png", ".webp"}
            else None
        ),
        "evidence_media": (
            f"/workers/intake/{request.intake_id}/evidence"
            if evidence_name
            else None
        ),
        "evidence_media_type": (
            "video"
            if evidence_name and extension in {".mp4", ".webm", ".mov"}
            else "image"
            if evidence_name
            else None
        ),
        "latitude": request.latitude,
        "longitude": request.longitude,
        "captured_at_utc": request.captured_at_utc,
        "saved_at_utc": saved_at,
        "assessor_review_required": True,
        "notice": (
            "Self-declaration saved for assessor review. "
            "Skill matches are preliminary and do not establish "
            "competence or certification."
        ),
    }

    # Save the actual intake to Supabase.
    supabase.table("worker_intakes").insert(
        {
            "intake_id": request.intake_id,
            "worker_id": request.worker_id,
            "worker_name": request.worker_name or None,
            "channel": request.channel,
            "language": request.language,
            "declaration_text": request.declaration_text,
            "evidence_media": (
                response["evidence_media"]
                or response["evidence_photo"]
            ),
            "latitude": request.latitude,
            "longitude": request.longitude,
            "captured_at_utc": request.captured_at_utc,
            "saved_at_utc": saved_at,
        }
    ).execute()

    return response
    
@app.get("/workers/intake")
def list_worker_intakes() -> dict[str, object]:
    """List worker self-declarations for assessor review."""
    try:
        result = (
            supabase
            .table("worker_intakes")
            .select("*")
            .order("created_at", desc=True)
            .execute()
        )

        return {
            "intake_count": len(result.data or []),
            "intakes": result.data or [],
        }

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"Could not load worker intakes: {error}",
        ) from error

@app.get("/workers/intake/{intake_id}/evidence")
def get_worker_intake_evidence(intake_id: str) -> FileResponse:
    """Return captured evidence for assessor review."""

    if not WORKER_INTAKES_PATH.exists():
        raise HTTPException(status_code=404, detail="Evidence not found.")

    with WORKER_INTAKES_LOCK:
        with WORKER_INTAKES_PATH.open(encoding="utf-8") as intake_file:
            intakes = json.load(intake_file)

    record = next(
        (item for item in intakes if item["intake_id"] == intake_id),
        None,
    )

    evidence_name = record.get("evidence_name") if record else None

    if not evidence_name:
        raise HTTPException(
            status_code=404,
            detail="Evidence not found.",
        )

    evidence_path = (WORKER_EVIDENCE_DIR / evidence_name).resolve()

    if (
        evidence_path.parent != WORKER_EVIDENCE_DIR.resolve()
        or not evidence_path.is_file()
    ):
        raise HTTPException(
            status_code=404,
            detail="Evidence not found.",
        )

    media_types = {
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
    }

    return FileResponse(
        evidence_path,
        media_type=media_types.get(
            evidence_path.suffix.lower(),
            "application/octet-stream",
        ),
    )

@app.get("/assessment/checklist")
def get_assessment_checklist() -> dict[str, object]:
    """Return a small assessor checklist based on current NQR criteria."""
    return {
        "qualification_code": NQR_QUALIFICATION_DATA["qualification_code"],
        "qualification_name": NQR_QUALIFICATION_DATA["qualification_name"],
        "source_url": ASSESSMENT_CHECKLIST["source_url"],
        "items": ASSESSMENT_CHECKLIST["items"],
        "rating_options": ASSESSMENT_CHECKLIST["rating_options"],
        "notice": ASSESSMENT_CHECKLIST["notice"],
    }


def _rating_summary(ratings: list[CriterionRating]) -> dict[str, object]:
    """Return an explainable prototype indicator; this is not an NSQF pass score."""
    applicable = [rating for rating in ratings if rating.rating != "not_observed"]
    points = sum({"demonstrated": 2, "partially_demonstrated": 1, "not_demonstrated": 0}[rating.rating] for rating in applicable)
    counts = {
        option["value"]: sum(rating.rating == option["value"] for rating in ratings)
        for option in ASSESSMENT_CHECKLIST["rating_options"]
    }
    return {
        "rating_counts": counts,
        "applicable_criteria": len(applicable),
        "score_indicator_percent": round(points / (2 * len(applicable)) * 100) if applicable else None,
        "score_method": "demonstrated=2, partially_demonstrated=1, not_demonstrated=0; not_observed excluded",
        "score_notice": "Prototype rating indicator only. It is not an official NSQF score, pass threshold, or certification decision.",
    }


@app.post("/assessment/score-preview")
def preview_assessment_score(request: AssessmentScoringRequest) -> dict[str, object]:
    """Summarize assessor-entered ratings without deciding pass/fail."""
    valid_ids = {item["id"] for item in ASSESSMENT_CHECKLIST["items"]}
    submitted_ids = [rating.criterion_id for rating in request.ratings]
    unknown_ids = sorted(set(submitted_ids) - valid_ids)

    if unknown_ids:
        return {
            "error": "Unknown criterion_id values",
            "unknown_criterion_ids": unknown_ids,
        }

    summary = _rating_summary(request.ratings)

    return {
        "worker_id": request.worker_id,
        "assessor_name": request.assessor_name,
        "ratings_received": len(request.ratings),
        **summary,
        "assessor_decision_required": True,
        "assessor_recommendation": request.assessor_recommendation,
        "certification_decision": None,
        "notice": "Prototype summary only. A qualified assessor reviews the evidence and makes the assessment decision.",
    }


@app.post("/assessment/sync")
def sync_assessment(request: AssessmentScoringRequest) -> dict[str, object]:
    """Persist an assessor-submitted demo record after an explicit sync action."""
    valid_ids = {item["id"] for item in ASSESSMENT_CHECKLIST["items"]}
    submitted_ids = [rating.criterion_id for rating in request.ratings]
    unknown_ids = sorted(set(submitted_ids) - valid_ids)
    if unknown_ids:
        raise HTTPException(
            status_code=400,
            detail={"message": "Unknown checklist criteria", "ids": unknown_ids},
        )
    if len(submitted_ids) != len(set(submitted_ids)):
        raise HTTPException(status_code=400, detail="A criterion can only be submitted once.")
    if not submitted_ids:
        raise HTTPException(status_code=400, detail="Add at least one criterion rating before syncing.")
    if not any(rating.rating != "not_observed" for rating in request.ratings):
        raise HTTPException(
            status_code=400,
            detail="Rate at least one observed criterion before syncing; an all-not-observed checklist cannot be compared.",
        )

    summary = _rating_summary(request.ratings)

    record = {
        "record_id": request.client_record_id or str(uuid4()),
        "client_record_id": request.client_record_id,
        "worker_id": request.worker_id,
        "assessor_name": request.assessor_name,
        "assessment_mode": request.assessment_mode,
        "assessor_recommendation": request.assessor_recommendation,
        "qualification_code": NQR_QUALIFICATION_DATA["qualification_code"],
        "ratings": [rating.model_dump() for rating in request.ratings],
        **summary,
        "synced_at": datetime.now(timezone.utc).isoformat(),
        "assessor_decision_required": True,
        "certification_decision": None,
    }

    with ASSESSMENT_RECORDS_LOCK:
        if ASSESSMENT_RECORDS_PATH.exists():
            with ASSESSMENT_RECORDS_PATH.open(encoding="utf-8") as records_file:
                records = json.load(records_file)
        else:
            records = []
        if request.client_record_id:
            already_saved = next(
                (item for item in records if item.get("client_record_id") == request.client_record_id),
                None,
            )
            if already_saved:
                return {
                    "record_id": already_saved["record_id"],
                    "worker_id": already_saved["worker_id"],
                    "ratings_received": len(already_saved["ratings"]),
                    **{key: already_saved[key] for key in ("rating_counts", "applicable_criteria", "score_indicator_percent", "score_method", "score_notice") if key in already_saved},
                    "synced_at": already_saved["synced_at"],
                    "assessor_decision_required": True,
                    "assessor_recommendation": already_saved.get("assessor_recommendation", "pending"),
                    "certification_decision": None,
                    "notice": "This queued prototype record was already saved on this server.",
                }
        records.append(record)
        with ASSESSMENT_RECORDS_PATH.open("w", encoding="utf-8") as records_file:
            json.dump(records, records_file, ensure_ascii=False, indent=2)

    return {
        "record_id": record["record_id"],
        "worker_id": record["worker_id"],
        "ratings_received": len(request.ratings),
        **summary,
        "synced_at": record["synced_at"],
        "assessor_decision_required": True,
        "assessor_recommendation": request.assessor_recommendation,
        "certification_decision": None,
        "notice": "Prototype record saved on this server for assessor review. It is not an official assessment or certification decision.",
    }


def read_assessment_records() -> list[dict[str, object]]:
    if not ASSESSMENT_RECORDS_PATH.exists():
        return []
    with ASSESSMENT_RECORDS_LOCK:
        with ASSESSMENT_RECORDS_PATH.open(encoding="utf-8") as records_file:
            return json.load(records_file)


@app.get("/assessment/records")
def list_assessment_records() -> dict[str, object]:
    """List locally synced demo records for assessor review."""
    records = read_assessment_records()
    return {
        "record_count": len(records),
        "records": [
            {
                "record_id": record["record_id"],
                "worker_id": record["worker_id"],
                "assessor_name": record["assessor_name"],
                "assessment_mode": record.get("assessment_mode", "tool_assisted"),
                "assessor_recommendation": record.get("assessor_recommendation", "pending"),
                "qualification_code": record["qualification_code"],
                "rating_counts": record["rating_counts"],
                "synced_at": record["synced_at"],
                "assessor_decision_required": True,
            }
            for record in records
        ],
    }


@app.get("/assessment/consistency")
def assessment_consistency() -> dict[str, object]:
    """Calculate pairwise exact agreement for independent assessor records."""
    records = read_assessment_records()
    assessor_pairs: list[dict[str, object]] = []
    latest_by_assessor: dict[tuple[str, str, str, str], dict[str, object]] = {}
    for record in records:
        key = (
            str(record["worker_id"]),
            str(record["qualification_code"]),
            str(record.get("assessment_mode", "tool_assisted")),
            str(record["assessor_name"]).strip().casefold(),
        )
        if key not in latest_by_assessor or str(record["synced_at"]) > str(latest_by_assessor[key]["synced_at"]):
            latest_by_assessor[key] = record

    for first, second in combinations(latest_by_assessor.values(), 2):
        if first["worker_id"] != second["worker_id"]:
            continue
        if first["qualification_code"] != second["qualification_code"]:
            continue
        first_mode = first.get("assessment_mode", "tool_assisted")
        second_mode = second.get("assessment_mode", "tool_assisted")
        if first_mode != second_mode:
            continue

        first_ratings = {
            item["criterion_id"]: item["rating"] for item in first["ratings"]
        }
        second_ratings = {
            item["criterion_id"]: item["rating"] for item in second["ratings"]
        }
        common_ids = set(first_ratings) & set(second_ratings)
        observed_ids = [
            criterion_id
            for criterion_id in common_ids
            if first_ratings[criterion_id] != "not_observed"
            and second_ratings[criterion_id] != "not_observed"
        ]
        if not observed_ids:
            continue
        agreements = sum(
            first_ratings[criterion_id] == second_ratings[criterion_id]
            for criterion_id in observed_ids
        )
        criterion_agreements = {
            criterion_id: first_ratings[criterion_id] == second_ratings[criterion_id]
            for criterion_id in observed_ids
        }
        assessor_pairs.append(
            {
                "worker_id": first["worker_id"],
                "qualification_code": first["qualification_code"],
                "assessment_mode": first_mode,
                "first_assessor": first["assessor_name"],
                "second_assessor": second["assessor_name"],
                "criteria_compared": len(observed_ids),
                "agreements": agreements,
                "criterion_agreements": criterion_agreements,
                "exact_agreement_percent": round(100 * agreements / len(observed_ids), 1),
            }
        )

    mode_summaries = []
    for mode in ("manual_baseline", "tool_assisted"):
        mode_pairs = [pair for pair in assessor_pairs if pair["assessment_mode"] == mode]
        total_agreements = sum(int(pair["agreements"]) for pair in mode_pairs)
        total_criteria = sum(int(pair["criteria_compared"]) for pair in mode_pairs)
        mode_summaries.append(
            {
                "assessment_mode": mode,
                "assessor_pairs": len(mode_pairs),
                "criteria_compared": total_criteria,
                "agreements": total_agreements,
                "exact_agreement_percent": (
                    round(100 * total_agreements / total_criteria, 1)
                    if total_criteria
                    else None
                ),
            }
        )

    paired_differences: list[dict[str, object]] = []
    paired_by_case: dict[tuple[str, str, str, tuple[str, str]], dict[str, dict[str, object]]] = {}
    for pair in assessor_pairs:
        assessor_names = tuple(sorted((
            str(pair["first_assessor"]).strip().casefold(),
            str(pair["second_assessor"]).strip().casefold(),
        )))
        case_key = (
            str(pair["worker_id"]),
            str(pair["qualification_code"]),
            str(pair["assessment_mode"]),
            assessor_names,
        )
        paired_by_case.setdefault(case_key, {})[str(pair["assessment_mode"])] = pair
    paired_cases: dict[tuple[str, str, tuple[str, str]], dict[str, dict[str, object]]] = {}
    for (worker_id, qualification_code, mode, assessor_names), by_mode in paired_by_case.items():
        paired_cases.setdefault((worker_id, qualification_code, assessor_names), {}).update(by_mode)
    matched_manual_agreements = 0
    matched_assisted_agreements = 0
    matched_manual_criteria = 0
    matched_assisted_criteria = 0
    for (worker_id, qualification_code, assessor_names), by_mode in paired_cases.items():
        manual = by_mode.get("manual_baseline")
        assisted = by_mode.get("tool_assisted")
        if manual is None or assisted is None:
            continue
        common_criteria = set(manual["criterion_agreements"]) & set(assisted["criterion_agreements"])
        if not common_criteria:
            continue
        manual_agreements = sum(bool(manual["criterion_agreements"][key]) for key in common_criteria)
        assisted_agreements = sum(bool(assisted["criterion_agreements"][key]) for key in common_criteria)
        matched_manual_agreements += manual_agreements
        matched_assisted_agreements += assisted_agreements
        matched_manual_criteria += len(common_criteria)
        matched_assisted_criteria += len(common_criteria)
        manual_matched_percent = round(100 * manual_agreements / len(common_criteria), 1)
        assisted_matched_percent = round(100 * assisted_agreements / len(common_criteria), 1)
        paired_differences.append(
            {
                "worker_id": worker_id,
                "qualification_code": qualification_code,
                "assessors": list(assessor_names),
                "criteria_compared_in_both_modes": len(common_criteria),
                "manual_agreement_percent": manual_matched_percent,
                "tool_assisted_agreement_percent": assisted_matched_percent,
                "difference_percentage_points": round(
                    assisted_matched_percent - manual_matched_percent,
                    1,
                ),
            }
        )

    paired_mode_summary = None
    if matched_manual_criteria and matched_assisted_criteria:
        manual_percent = round(100 * matched_manual_agreements / matched_manual_criteria, 1)
        assisted_percent = round(100 * matched_assisted_agreements / matched_assisted_criteria, 1)
        paired_mode_summary = {
            "matched_cases": len(paired_differences),
            "manual_criteria_compared": matched_manual_criteria,
            "tool_assisted_criteria_compared": matched_assisted_criteria,
            "manual_agreement_percent": manual_percent,
            "tool_assisted_agreement_percent": assisted_percent,
            "difference_percentage_points": round(assisted_percent - manual_percent, 1),
        }

    return {
        "independent_assessor_pairs": len(assessor_pairs),
        "pair_results": assessor_pairs,
        "mode_summaries": mode_summaries,
        "paired_mode_summary": paired_mode_summary,
        "paired_mode_differences": paired_differences,
        "interpretation": (
            "Agreement is descriptive. Compare tool-assisted and manual-baseline results only when the same assessors score the same test cases in both modes; a small demo does not establish broad improvement."
        ),
        "notice": "Only ratings from differently named assessors on the same worker, qualification, and mode are compared. Not-observed criteria are excluded. Latest submission per assessor, worker, qualification, and mode is used.",
    }
