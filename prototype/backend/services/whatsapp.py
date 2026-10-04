"""Meta WhatsApp Cloud API webhook adapter for prototype worker intake.

No WhatsApp numbers, message text, access tokens, or audio files are written to
logs. Contact identifiers are stored only as keyed hashes. Voice transcription
is opt-in through the chat flow and requires a configured transcription API.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from threading import Lock
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import httpx


BACKEND_DIR = Path(__file__).resolve().parents[1]
INBOX_PATH = BACKEND_DIR / "data" / "whatsapp_inbox.json"
CONSENTS_PATH = BACKEND_DIR / "data" / "whatsapp_consents.json"
GRAPH_VERSION = os.getenv("WHATSAPP_GRAPH_API_VERSION", "v23.0")
MAX_AUDIO_BYTES = 16 * 1024 * 1024
FILE_LOCK = Lock()


def _env(name: str) -> str:
    return os.getenv(name, "").strip()


def webhook_ready() -> dict[str, Any]:
    return {
        "configured": bool(_env("WHATSAPP_VERIFY_TOKEN") and _env("WHATSAPP_APP_SECRET") and _env("WHATSAPP_ACCESS_TOKEN") and _env("WHATSAPP_PHONE_NUMBER_ID")),
        "transcription_configured": bool(_env("OPENAI_API_KEY")),
        "transcription_provider": "OpenAI audio transcription" if _env("OPENAI_API_KEY") else None,
        "notice": "Use a public HTTPS webhook URL. Voice-note transcription requires explicit worker consent and OPENAI_API_KEY.",
    }


def verify_signature(raw_body: bytes, signature_header: str | None) -> bool:
    secret = _env("WHATSAPP_APP_SECRET")
    if not secret or not signature_header or not signature_header.startswith("sha256="):
        return False
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header)


def _contact_ref(phone: str) -> str:
    # The app secret makes the stable contact ID hard to reverse via a phone list.
    salt = _env("WHATSAPP_APP_SECRET") or "local-prototype"
    return hashlib.sha256(f"{salt}:{phone}".encode()).hexdigest()[:24]


def _load_list(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as source:
        data = json.load(source)
    return data if isinstance(data, list) else []


def _write_list(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as target:
        json.dump(rows, target, ensure_ascii=False, indent=2)
    temporary.replace(path)


def _consented(contact_ref: str) -> bool:
    return any(row.get("contact_ref") == contact_ref for row in _load_list(CONSENTS_PATH))


def _record_consent(contact_ref: str, consent: bool) -> None:
    with FILE_LOCK:
        rows = [row for row in _load_list(CONSENTS_PATH) if row.get("contact_ref") != contact_ref]
        if consent:
            rows.append({"contact_ref": contact_ref, "consented_at_utc": datetime.now(timezone.utc).isoformat()})
        _write_list(CONSENTS_PATH, rows)


def _record_message(message_id: str, contact_ref: str, state: str, detail: str = "") -> None:
    with FILE_LOCK:
        rows = _load_list(INBOX_PATH)
        existing = next((row for row in rows if row.get("message_id") == message_id), None)
        record = {
            "message_id": message_id,
            "contact_ref": contact_ref,
            "state": state,
            "detail": detail[:240],
            "updated_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        if existing:
            existing.update(record)
        else:
            rows.append(record)
        _write_list(INBOX_PATH, rows[-1000:])


def inbox_summary() -> dict[str, Any]:
    rows = _load_list(INBOX_PATH)
    counts: dict[str, int] = {}
    for row in rows:
        state = row.get("state", "unknown")
        counts[state] = counts.get(state, 0) + 1
    return {"configured": webhook_ready(), "message_count": len(rows), "states": counts, "recent": rows[-10:][::-1]}


def _send_text_reply(client: httpx.Client, to: str, body: str, reply_to: str | None = None) -> None:
    phone_id = _env("WHATSAPP_PHONE_NUMBER_ID")
    token = _env("WHATSAPP_ACCESS_TOKEN")
    payload: dict[str, Any] = {
        "messaging_product": "whatsapp",
        "recipient_type": "individual",
        "to": to,
        "type": "text",
        "text": {"preview_url": False, "body": body},
    }
    if reply_to:
        payload["context"] = {"message_id": reply_to}
    response = client.post(
        f"https://graph.facebook.com/{GRAPH_VERSION}/{phone_id}/messages",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
    )
    response.raise_for_status()


def _get_audio(client: httpx.Client, media_id: str) -> tuple[bytes, str, str]:
    token = _env("WHATSAPP_ACCESS_TOKEN")
    response = client.get(
        f"https://graph.facebook.com/{GRAPH_VERSION}/{media_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    response.raise_for_status()
    media = response.json()
    url = media.get("url", "")
    parsed = urlparse(url)
    allowed_host = parsed.hostname and (
        parsed.hostname == "fbcdn.net"
        or parsed.hostname.endswith(".fbcdn.net")
        or parsed.hostname == "fbsbx.com"
        or parsed.hostname.endswith(".fbsbx.com")
    )
    if parsed.scheme != "https" or not allowed_host:
        raise ValueError("Meta returned an unexpected media host.")
    media_response = client.get(url, headers={"Authorization": f"Bearer {token}"})
    media_response.raise_for_status()
    if len(media_response.content) > MAX_AUDIO_BYTES:
        raise ValueError("Voice note is larger than the 16 MB intake limit.")
    mime_type = str(media.get("mime_type") or media_response.headers.get("content-type", "audio/ogg")).split(";")[0]
    if mime_type not in {"audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"}:
        raise ValueError("Unsupported WhatsApp audio format.")
    suffix = {"audio/aac": ".aac", "audio/mp4": ".m4a", "audio/mpeg": ".mp3", "audio/amr": ".amr", "audio/ogg": ".ogg"}[mime_type]
    return media_response.content, mime_type, suffix


def _transcribe(audio: bytes, mime_type: str, suffix: str) -> str:
    api_key = _env("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Voice transcription is not configured yet. Please type your work experience instead.")
    model = _env("WHATSAPP_TRANSCRIPTION_MODEL") or "gpt-4o-mini-transcribe"
    response = httpx.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {api_key}"},
        data={"model": model},
        files={"file": (f"worker-voice{suffix}", audio, mime_type)},
        timeout=120,
    )
    response.raise_for_status()
    transcript = str(response.json().get("text", "")).strip()
    if not transcript:
        raise ValueError("The voice note did not produce a transcript. Please try again or type your statement.")
    return transcript[:12000]


def _messages(payload: dict[str, Any]):
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            contacts = {item.get("wa_id"): item.get("profile", {}).get("name", "") for item in value.get("contacts", [])}
            for message in value.get("messages", []):
                yield message, contacts.get(message.get("from"), "")


def process_webhook_payload(payload: dict[str, Any], save_intake: Callable[[Any], dict[str, Any]], request_model: Callable[..., Any]) -> None:
    """Process a signed webhook after acknowledging Meta's POST request."""
    if not (_env("WHATSAPP_ACCESS_TOKEN") and _env("WHATSAPP_PHONE_NUMBER_ID")):
        return
    try:
        with httpx.Client(timeout=30) as client:
            for message, profile_name in _messages(payload):
                message_id = str(message.get("id", ""))
                phone = str(message.get("from", ""))
                if not message_id or not phone or not re.fullmatch(r"[0-9]{6,20}", phone):
                    continue
                contact_ref = _contact_ref(phone)
                if any(row.get("message_id") == message_id for row in _load_list(INBOX_PATH)):
                    continue
                kind = message.get("type")
                body = str(message.get("text", {}).get("body", "")).strip() if kind == "text" else ""
                command = body.casefold()
                if command in {"stop", "unsubscribe", "बंद"}:
                    _record_consent(contact_ref, False)
                    _record_message(message_id, contact_ref, "opted_out")
                    _send_text_reply(client, phone, "Stopped. Your future messages will not be processed. Send START if you want to begin again.", message_id)
                    continue
                if command in {"start", "hi", "hello", "namaste", "नमस्ते"} and not _consented(contact_ref):
                    _record_message(message_id, contact_ref, "awaiting_consent")
                    _send_text_reply(client, phone, "Welcome to Innov8 RPL. We use your work statement to suggest relevant skill modules for assessor review. If you send a voice note, it will be transcribed using the configured speech service. This does not certify skills. Reply YES to consent, or STOP to opt out.", message_id)
                    continue
                if command in {"yes", "हाँ", "हां", "ha"}:
                    _record_consent(contact_ref, True)
                    _record_message(message_id, contact_ref, "consented")
                    _send_text_reply(client, phone, "Thank you. Now type or send a WhatsApp voice note describing the electrical work you have done. Do not share passwords, IDs, or bank details.", message_id)
                    continue
                if not _consented(contact_ref):
                    _record_message(message_id, contact_ref, "awaiting_consent")
                    _send_text_reply(client, phone, "Please send START, then reply YES before sharing a work statement or voice note. Send STOP to opt out.", message_id)
                    continue

                try:
                    if kind == "audio":
                        media_id = str(message.get("audio", {}).get("id", ""))
                        if not media_id:
                            raise ValueError("The voice note did not include a downloadable media ID.")
                        audio, mime_type, suffix = _get_audio(client, media_id)
                        statement = _transcribe(audio, mime_type, suffix)
                        language = "auto"
                    elif kind == "text" and body:
                        statement = body
                        language = "und"
                    else:
                        _record_message(message_id, contact_ref, "unsupported_message")
                        _send_text_reply(client, phone, "Please send a text statement or voice note. Photos and other attachments are not processed by this demo yet.", message_id)
                        continue
                except Exception as error:
                    _record_message(message_id, contact_ref, "processing_error", type(error).__name__)
                    _send_text_reply(client, phone, "We could not process this message. Please try a shorter voice note or type your experience. If you sent a voice note, check that transcription is configured.", message_id)
                    continue

                intake_id = "wa_" + hashlib.sha256(message_id.encode()).hexdigest()[:40]
                intake = request_model(
                    intake_id=intake_id,
                    worker_id=f"wa-{contact_ref}",
                    worker_name=profile_name[:120],
                    channel="whatsapp",
                    language=language,
                    declaration_text=statement,
                )
                try:
                    result = save_intake(intake)
                    _record_message(message_id, contact_ref, "intake_saved", str(result.get("intake_id", "")))
                    _send_text_reply(client, phone, "Your statement has been saved for assessor review. Module matches are preliminary and do not confirm competence or certification.", message_id)
                except Exception as error:
                    _record_message(message_id, contact_ref, "processing_error", type(error).__name__)
                    _send_text_reply(client, phone, "We could not process that message just now. Please try again later or contact your assessor.", message_id)
    except Exception as error:
        # Keep webhook payloads/media out of logs; record only a short error category.
        _record_message("webhook-processing-error", "system", "processing_error", type(error).__name__)
