"""Preliminary semantic matching against the current NQR qualification modules.

The embedding model is loaded lazily so the API can still start on a small or
offline development machine. Set RPL_EMBEDDING_MODEL to select another local
Sentence Transformers model. The multilingual default is intentional because
the worker intake supports Indian-language speech recognition.
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any


BACKEND_DIR = Path(__file__).resolve().parents[1]
QP_PATH = BACKEND_DIR / "data" / "assistant_electrician_nqr_demo.json"
CHECKLIST_PATH = BACKEND_DIR / "data" / "assessment_checklist.json"
MODEL_NAME = os.environ.get(
    "RPL_EMBEDDING_MODEL",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
)
MIN_SIMILARITY = float(os.environ.get("RPL_MIN_SIMILARITY", "0.22"))


def _load_reference() -> tuple[dict[str, Any], dict[str, Any]]:
    with QP_PATH.open(encoding="utf-8") as source:
        qp_data = json.load(source)
    with CHECKLIST_PATH.open(encoding="utf-8") as source:
        checklist = json.load(source)
    return qp_data, checklist


def _normalize_module_code(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def _module_corpus() -> list[dict[str, Any]]:
    qp_data, checklist = _load_reference()
    criteria_by_code: dict[str, list[str]] = {}
    for item in checklist.get("items", []):
        code = _normalize_module_code(item.get("module_code", ""))
        criteria_by_code.setdefault(code, []).append(
            f"{item.get('criterion', '')}. {item.get('evidence_prompt', '')}"
        )

    corpus = []
    for module in qp_data.get("mandatory_modules", []):
        code = str(module.get("code", ""))
        normalized = _normalize_module_code(code)
        aligned_criteria = [
            sentence
            for checklist_code, sentences in criteria_by_code.items()
            if normalized.startswith(checklist_code) or checklist_code.startswith(normalized)
            for sentence in sentences
        ]
        mapping_terms = [
            f"{mapping['skill']}. {mapping['reason']}"
            for mapping in qp_data.get("demo_skill_mappings", [])
            if code in mapping.get("nos_codes", [])
        ]
        searchable_text = " ".join(
            part for part in [code, str(module.get("title", "")), *aligned_criteria, *mapping_terms] if part
        )
        corpus.append({"code": code, "title": module.get("title", code), "text": searchable_text})
    return corpus


@lru_cache(maxsize=1)
def _load_model() -> tuple[Any | None, str | None]:
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        return None, "sentence-transformers is not installed; using the transparent demo text matcher."
    try:
        return SentenceTransformer(MODEL_NAME), None
    except Exception as error:  # model download/cache problems must not stop API startup
        return None, f"Embedding model unavailable ({type(error).__name__}); using the transparent demo text matcher."


def matcher_status() -> dict[str, Any]:
    model, issue = _load_model()
    return {
        "engine": "sentence-transformers" if model is not None else "demo_text_overlap_fallback",
        "model": MODEL_NAME if model is not None else None,
        "semantic_matching_ready": model is not None,
        "message": issue or "Semantic suggestions are preliminary and require assessor review.",
    }


def _fallback_similarity(query: str, candidate: str) -> float:
    """Small deterministic fallback for offline demos without embedding packages."""
    stop_words = {
        "and", "the", "for", "with", "from", "that", "this", "have", "years",
        "work", "worker", "skill", "experience", "used", "using", "into", "about",
    }
    query_terms = {word for word in re.findall(r"[a-z0-9]+", query.casefold()) if len(word) > 2 and word not in stop_words}
    candidate_terms = {word for word in re.findall(r"[a-z0-9]+", candidate.casefold()) if len(word) > 2 and word not in stop_words}
    if not query_terms or not candidate_terms:
        return 0.0
    return len(query_terms & candidate_terms) / len(query_terms | candidate_terms)


def match_qualification_pack(worker_declaration_text: str) -> dict[str, Any]:
    qp_data, _ = _load_reference()
    modules = _module_corpus()
    query = worker_declaration_text.strip()
    model, model_issue = _load_model()
    method = "sentence_transformers_cosine_similarity"

    if model is not None and query and modules:
        try:
            vectors = model.encode(
                [query, *[module["text"] for module in modules]],
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
            scores = [float(vectors[0] @ vector) for vector in vectors[1:]]
        except Exception as error:
            model_issue = f"Embedding inference unavailable ({type(error).__name__}); using demo text overlap."
            model = None

    if model is None:
        method = "demo_text_overlap_fallback"
        scores = [_fallback_similarity(query, module["text"]) for module in modules]

    ranked = sorted(zip(modules, scores), key=lambda entry: entry[1], reverse=True)
    selected = [entry for entry in ranked if entry[1] >= MIN_SIMILARITY][:3]
    mapping_data = qp_data.get("demo_skill_mappings", [])
    matches = []
    for module, score in selected:
        matched_skills = [
            item["skill"] for item in mapping_data
            if module["code"] in item.get("nos_codes", [])
            and any(token in query.casefold() for token in item["skill"].casefold().split())
        ]
        matches.append({
            "code": module["code"],
            "title": module["title"],
            "matched_skills": matched_skills,
            "similarity_score": round(score, 4),
            "match_reasons": [{"reason": "Semantic similarity to the worker's description and available NQR module criteria."}],
        })

    method_notice = (
        "Embedding similarity is an uncalibrated retrieval score, not a probability or competence score. "
        "Only one qualification is configured in this prototype; an assessor must confirm relevance."
    )
    if model_issue:
        method_notice = f"{model_issue} {method_notice}"
    return {
        "matches": matches,
        "unmatched_terms": [] if matches else [query] if query else [],
        "method": method,
        "notice": method_notice,
        "qualification": {
            "code": qp_data.get("qualification_code"),
            "name": qp_data.get("qualification_name"),
            "nsqf_level": qp_data.get("nsqf_level"),
        },
    }
